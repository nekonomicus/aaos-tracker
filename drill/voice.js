/* FMH DRILL · voice.js
   One WebRTC connection to the OpenAI Realtime API: the examiner hears the microphone and
   answers with his own voice, no record → transcribe → chat → TTS round trip. app.js decides
   what the examiner is told; this file only moves audio and events.

   const v = new RealtimeVoice({ apiKey, session, onEvent, onState });
   await v.connect();             // opens the mic, negotiates SDP with /v1/realtime/calls
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
      this.closed = false; this.needsUpdate = false; this._opened = null; this._timer = null; this._grace = null;
    }

    emit(patch) { Object.assign(this.state, patch); this.onState({ ...this.state }); }

    async connect() {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Dieser Browser kann kein WebRTC / Mikrofon');
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (this.closed) throw new Error('abgebrochen'); // close() ran while the microphone prompt was open
        const pc = new RTCPeerConnection();
        this.pc = pc;
        pc.ontrack = (e) => { this.audioEl.srcObject = e.streams[0]; this.audioEl.play().catch(() => {}); };
        pc.addTrack(this.mic.getTracks()[0], this.mic);
        pc.onconnectionstatechange = () => this.onConnectionState(pc);
        const dc = pc.createDataChannel('oai-events');
        this.dc = dc;
        const opened = new Promise((resolve, reject) => {
          this._opened = { resolve, reject };
          this._timer = setTimeout(() => reject(new Error('Zeitüberschreitung beim Verbinden')), 20000);
          dc.onopen = () => { if (this.needsUpdate) this.send({ type: 'session.update', session: this.session }); else this.ready(); };
          dc.onerror = (e) => reject(new Error(e.message || 'Datenkanal'));
        });
        dc.onclose = () => { if (!this.closed) { this.close(); this.onEvent({ type: 'fmh.disconnected', reason: 'datachannel' }); } };
        dc.onmessage = (e) => { let ev = null; try { ev = JSON.parse(e.data); } catch { return; } this.handle(ev); };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const answer = await this.exchange(offer.sdp);
        if (this.closed) throw new Error('abgebrochen');
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        await opened;
      } catch (error) { this.close(); throw error; }
    }

    ready() { clearTimeout(this._timer); this.emit({ connected: true }); if (this._opened) { this._opened.resolve(); this._opened = null; } }

    // One multipart request carries the SDP offer and the whole session config (the SDK's canonical call);
    // a rejected config is reported as the server names it, the exam then goes on in text mode. Only if the
    // request itself is refused, the plain-SDP form is tried and the config follows as session.update, which
    // must be acknowledged (session.updated) before the call counts as open: never run on server defaults.
    async exchange(sdp) {
      const headers = { authorization: `Bearer ${this.apiKey}`, accept: 'application/sdp' };
      const form = new FormData();
      form.append('sdp', new Blob([sdp], { type: 'application/sdp' }), ''); // filename-less typed parts, as the official SDK sends them
      form.append('session', new Blob([JSON.stringify(this.session)], { type: 'application/json' }), '');
      let res = await fetch(`${OPENAI}/realtime/calls`, { method: 'POST', headers, body: form });
      if (res.ok) return res.text();
      const first = await res.text().catch(() => '');
      let message = ''; try { message = JSON.parse(first).error?.message || ''; } catch { /* not json */ }
      if (res.status !== 400 || /session|audio|instructions|voice|model|tool|turn_detection|transcription|reasoning|modalit|token/i.test(message)) throw new Error(message || `Realtime ${res.status}`);
      this.needsUpdate = true;
      res = await fetch(`${OPENAI}/realtime/calls?model=${encodeURIComponent(this.session.model)}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/sdp' }, body: sdp });
      if (!res.ok) { let m = message || `Realtime ${res.status}`; try { m = JSON.parse(await res.text()).error?.message || m; } catch { /* keep */ } throw new Error(m); }
      return res.text();
    }

    onConnectionState(pc) {
      if (this.closed) return;
      const s = pc.connectionState; clearTimeout(this._grace);
      const drop = () => { this.close(); this.onEvent({ type: 'fmh.disconnected', reason: s }); };
      if (s === 'failed' || s === 'closed') drop();
      else if (s === 'disconnected') this._grace = setTimeout(() => { if (!this.closed && pc.connectionState === 'disconnected') drop(); }, 5000); // transient per spec: give ICE 5 s
    }

    handle(ev) {
      switch (ev.type) {
        case 'session.updated': if (this._opened) this.ready(); break;
        case 'input_audio_buffer.speech_started': this.emit({ listening: true }); break;
        case 'input_audio_buffer.speech_stopped': this.emit({ listening: false }); break;
        case 'output_audio_buffer.started': this.emit({ speaking: true }); break;
        case 'output_audio_buffer.stopped': case 'output_audio_buffer.cleared': this.emit({ speaking: false }); break;
        case 'response.created': this.emit({ responding: true }); break;
        case 'response.done': this.emit({ responding: false }); this.flush(); break;
        case 'error':
          if (this._opened) { const err = new Error(ev.error?.message || 'Realtime-Fehler'); this._opened.reject(err); this._opened = null; return; } // config refused during setup
          if (/active response/i.test(ev.error?.message || '')) { this.queue.unshift(this._lastResponse || {}); return; }
          this.emit({ responding: false }); this.flush();
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
      clearTimeout(this._timer); clearTimeout(this._grace);
      if (this._opened) { this._opened.reject(new Error('abgebrochen')); this._opened = null; }
      try { this.dc?.close(); } catch { /* ignore */ }
      try { this.pc?.close(); } catch { /* ignore */ }
      try { this.mic?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { this.audioEl.srcObject = null; } catch { /* ignore */ }
      this.queue = [];
      this.emit({ connected: false, listening: false, speaking: false, responding: false });
    }
  }

  window.RealtimeVoice = RealtimeVoice;
})();
