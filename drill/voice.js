/* FMH DRILL · voice.js
   One WebRTC connection to the OpenAI Realtime API: the examiner hears the microphone and
   answers with his own voice, no record → transcribe → chat → TTS round trip. app.js decides
   what the examiner is told; this file only moves audio and events.

   const v = new RealtimeVoice({ apiKey, session, onEvent, onState });
   await v.connect();             // opens mic, negotiates SDP with /v1/realtime/calls
   v.addText('system', '…');      // conversation.item.create
   v.respond();                   // response.create (queued while a response is running)
   v.toolResult(callId, output);  // function_call_output
   v.mute(true); v.close();                                                                   */
(function () {
  'use strict';

  const OPENAI = 'https://api.openai.com/v1';

  class RealtimeVoice {
    constructor({ apiKey, session, onEvent, onState, audioEl }) {
      this.apiKey = apiKey; this.session = session;
      this.onEvent = onEvent || (() => {}); this.onState = onState || (() => {});
      this.audioEl = audioEl || new Audio();
      this.audioEl.autoplay = true;
      this.pc = null; this.dc = null; this.mic = null;
      this.state = { connected: false, listening: false, speaking: false, responding: false, muted: false };
      this.queue = []; // response.create requests waiting for the running response to finish
      this.closed = false;
    }

    emit(patch) { Object.assign(this.state, patch); this.onState({ ...this.state }); }

    async connect() {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Dieser Browser kann kein WebRTC / Mikrofon');
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.ontrack = (e) => { this.audioEl.srcObject = e.streams[0]; this.audioEl.play().catch(() => {}); };
      pc.addTrack(this.mic.getTracks()[0], this.mic);
      pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && !this.closed) { this.close(); this.onEvent({ type: 'fmh.disconnected', reason: pc.connectionState }); } };
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      const opened = new Promise((resolve, reject) => {
        dc.onopen = () => { this.send({ type: 'session.update', session: this.session }); this.emit({ connected: true }); resolve(); };
        dc.onerror = (e) => reject(new Error(e.message || 'Datenkanal'));
        setTimeout(() => reject(new Error('Zeitüberschreitung beim Verbinden')), 20000);
      });
      dc.onclose = () => { if (!this.closed) { this.close(); this.onEvent({ type: 'fmh.disconnected', reason: 'datachannel' }); } };
      dc.onmessage = (e) => { let ev = null; try { ev = JSON.parse(e.data); } catch { return; } this.handle(ev); };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await this.exchange(offer.sdp);
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      await opened;
    }

    // SDP exchange. Preferred: one multipart request carrying the whole session config.
    // Fallback: plain SDP body with ?model=…; the session config then arrives via session.update.
    async exchange(sdp) {
      const headers = { authorization: `Bearer ${this.apiKey}` };
      const tryMultipart = async () => {
        const form = new FormData();
        form.append('sdp', new Blob([sdp], { type: 'application/sdp' }), ''); // filename-less typed parts, as the official SDK sends them
        form.append('session', new Blob([JSON.stringify(this.session)], { type: 'application/json' }), '');
        return fetch(`${OPENAI}/realtime/calls`, { method: 'POST', headers, body: form });
      };
      let res = await tryMultipart();
      if (!res.ok && res.status === 400) {
        const text = await res.text();
        if (/reasoning/i.test(text) && this.session.reasoning) { delete this.session.reasoning; res = await tryMultipart(); }
        else if (/noise_reduction|transcription|eagerness|semantic_vad/i.test(text)) {
          // an older model: drop the optional extras and try again
          const audio = this.session.audio || {};
          if (audio.input) { delete audio.input.noise_reduction; if (audio.input.turn_detection?.type === 'semantic_vad') audio.input.turn_detection = { type: 'server_vad', silence_duration_ms: 800, create_response: audio.input.turn_detection.create_response, interrupt_response: true }; }
          res = await tryMultipart();
        } else res = { ok: false, status: 400, text: async () => text };
      }
      if (!res.ok) {
        const first = await res.text().catch(() => '');
        res = await fetch(`${OPENAI}/realtime/calls?model=${encodeURIComponent(this.session.model)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/sdp' }, body: sdp });
        if (!res.ok) {
          let message = `Realtime ${res.status}`;
          try { message = JSON.parse(first || await res.text()).error?.message || message; } catch { /* keep */ }
          throw new Error(message);
        }
      }
      return res.text();
    }

    handle(ev) {
      switch (ev.type) {
        case 'input_audio_buffer.speech_started': this.emit({ listening: true }); break;
        case 'input_audio_buffer.speech_stopped': this.emit({ listening: false }); break;
        case 'output_audio_buffer.started': this.emit({ speaking: true }); break;
        case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared': this.emit({ speaking: false }); break;
        case 'response.created': this.emit({ responding: true }); break;
        case 'response.done': this.emit({ responding: false }); this.flush(); break;
        case 'error':
          if (/active response/i.test(ev.error?.message || '')) { this.queue.unshift(this._lastResponse || {}); return; }
          break;
        default: break;
      }
      this.onEvent(ev);
    }

    send(event) { if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(event)); }
    addText(role, text) { this.send({ type: 'conversation.item.create', item: { type: 'message', role, content: [{ type: 'input_text', text }] } }); }
    respond(response = {}) {
      if (this.state.responding) { this.queue.push(response); return; }
      this._lastResponse = response;
      this.send({ type: 'response.create', response });
      this.emit({ responding: true });
    }
    flush() { const next = this.queue.shift(); if (next) setTimeout(() => this.respond(next), 60); }
    cancel() { this.send({ type: 'response.cancel' }); this.send({ type: 'output_audio_buffer.clear' }); this.queue = []; }
    toolResult(callId, output) { this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: String(output ?? '') } }); }
    update(session) { Object.assign(this.session, session); this.send({ type: 'session.update', session }); }
    mute(on) { const track = this.mic?.getTracks()[0]; if (track) track.enabled = !on; this.emit({ muted: !!on }); }

    close() {
      if (this.closed) return; this.closed = true;
      try { this.dc?.close(); } catch { /* ignore */ }
      try { this.pc?.close(); } catch { /* ignore */ }
      try { this.mic?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { this.audioEl.srcObject = null; } catch { /* ignore */ }
      this.emit({ connected: false, listening: false, speaking: false, responding: false });
    }
  }

  window.RealtimeVoice = RealtimeVoice;
})();
