"""Dictation written down while you talk: the browser streams 16 kHz PCM in small POSTs, and each recording is a
session here. The audio is cut at pauses (Silero VAD, which comes with faster-whisper) or at 12 s, and every piece
is transcribed on the session's own thread as soon as it is cut, so Stop only has to wait for the last few seconds.

Audio already written down is never transcribed again. Each piece's prompt is the course-term hint and the last
CONTEXT_WORDS words written so far (whole words: Whisper uses its prompt for vocabulary and style, and a long one
risks it copying the prompt). If anything fails, the browser still has the whole recording and sends it to
/api/voice/transcribe as before.
"""
import queue, secrets, threading, time

import numpy as np

import voice as V

RATE = 16000
PAUSE_S = 0.6           # silence after speech that ends a piece
MIN_PIECE_S = 4.0       # a pause only cuts once this much is waiting: each Whisper call costs ~3 s however short
MAX_PIECE_S = 12.0      # no pause by then: cut anyway, at the best gap
MAX_CALL_S = 28.0       # a backlog joined into one call stays inside Whisper's 30 s window
CONTEXT_WORDS = 10      # measured: the fewest words that fixed the one real error at a cut
MAX_TOTAL_S = 130       # the browser stops at 120 s
IDLE_S = 30             # a session nobody has sent anything to for this long is dropped
PAD = round(0.2 * RATE)     # kept either side of the speech in a piece


def _silero(audio):
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
    except ImportError as e:
        raise V.VoiceError("Voice needs faster-whisper. Run: python -m pip install faster-whisper kokoro-onnx") from e
    opts = VadOptions(min_silence_duration_ms=300, speech_pad_ms=100)
    return [(s["start"], s["end"]) for s in get_speech_timestamps(audio, opts)]


# Hooks the tests replace: (audio, prompt) -> text, and audio -> speech spans [(start, end)] in samples.
TRANSCRIBE = V.transcribe_audio
SPEECH = _silero
_STOP = object()


class Dictation:
    def __init__(self, hint=""):
        self.hint, self.sid, self.used = hint, None, time.time()
        self.buf, self.cursor, self.seq = bytearray(), 0, 0     # cursor: the first sample not yet cut
        self.texts, self.error, self.cancelled, self.closed = [], None, False, False
        self.finishing = False      # Stop was pressed: the idle sweep leaves it alone, however long Whisper takes
        self._lock, self._q = threading.Lock(), queue.Queue()
        self._worker = threading.Thread(target=self._work, daemon=True)
        self._worker.start()

    @property
    def text(self):
        return " ".join(t for t in self.texts if t)

    def add(self, pcm, seq):
        """Raw int16 LE samples, in order (seq from 0) -> the text written down so far."""
        with self._lock:
            self.used = time.time()
            if self.closed:
                raise V.VoiceError("This dictation has already finished.", 409)
            if len(pcm) % 2:
                raise V.VoiceError("The recording arrived damaged.", 400)
            if seq != self.seq:
                raise V.VoiceError("A piece of the recording went missing.", 409)
            if (len(self.buf) + len(pcm)) // 2 > MAX_TOTAL_S * RATE:
                raise V.VoiceError("The recording is too long.", 413)
            self.buf += pcm
            self.seq += 1
            self._cut()
            return self.text

    def _tail(self):
        return np.frombuffer(self.buf, dtype="<i2", offset=self.cursor * 2).astype(np.float32) / 32768

    def _cut(self):
        # Every piece the audio so far holds; a chunk that piled up on a slow connection cuts as small ones would.
        while True:
            tail = self._tail()
            if len(tail) < MIN_PIECE_S * RATE:
                return
            spans = SPEECH(tail)
            if not spans:                           # silence: never sent
                if len(tail) > MAX_PIECE_S * RATE:
                    self.cursor += len(tail) - RATE // 2
                return
            if spans[0][0] > PAD:                   # silence before the speech isn't kept either
                skip = spans[0][0] - PAD
                self.cursor += skip
                tail, spans = tail[skip:], [(s - skip, e - skip) for s, e in spans]
            cut = self._pause(spans, len(tail))
            if cut is None and len(tail) >= MAX_PIECE_S * RATE:
                cut = self._forced(tail[:round(MAX_PIECE_S * RATE)], spans)
            if cut is None:
                return
            self._q.put(tail[:cut])
            self.cursor += cut

    @staticmethod
    def _pause(spans, n):
        """The first pause after speech that small chunks would have cut at: >= PAUSE_S of silence, reached once
        MIN_PIECE_S is waiting and before MAX_PIECE_S. Returns the cut (in samples) or None."""
        for i, (_, end) in enumerate(spans):
            nxt = spans[i + 1][0] if i + 1 < len(spans) else n
            seen = max(MIN_PIECE_S * RATE, end + PAUSE_S * RATE)
            if seen > MAX_PIECE_S * RATE:
                return None
            if seen <= nxt:
                return min(end + PAD, n)
        return None

    @staticmethod
    def _forced(win, spans):
        """No pause in the first 12 s: cut in the middle of the widest gap >= 0.15 s past 3 s, else at the
        quietest 100 ms in the last 2 s."""
        gaps = [(b - a, (a + b) // 2) for (_, a), (b, _) in zip(spans, spans[1:])
                if b - a >= 0.15 * RATE and (a + b) // 2 >= 3 * RATE and (a + b) // 2 < len(win)]
        if gaps:
            return max(gaps)[1]
        f = RATE // 10
        start = len(win) - 2 * RATE
        frames = win[start:start + (2 * RATE // f) * f].reshape(-1, f)
        return start + int(np.argmin((frames ** 2).mean(axis=1))) * f + f // 2

    def _prompt(self):
        words = self.text.split()       # whole words, so a word is never cut
        return " ".join([self.hint] + words[-CONTEXT_WORDS:] if CONTEXT_WORDS else [self.hint]).strip()

    def _work(self):
        held = None
        while True:
            item = held if held is not None else self._q.get()
            held = None
            if item is _STOP or self.cancelled:
                return
            batch = [item]      # free again with several pieces waiting: one call for all of them
            while True:
                try:
                    nxt = self._q.get_nowait()
                except queue.Empty:
                    break
                if nxt is _STOP or sum(map(len, batch)) + len(nxt) > MAX_CALL_S * RATE:
                    held = nxt
                    break
                batch.append(nxt)
            if self.cancelled:
                return
            if self.error:
                continue        # finish says so; the browser sends the whole recording instead
            try:
                text = TRANSCRIBE(np.concatenate(batch), self._prompt())
            except Exception as e:
                self.error = e
                continue
            if self.cancelled:
                return
            self.texts.append(text.strip())

    def finish(self, timeout=60):
        """Send what's left, wait for every piece, and return the whole text."""
        with self._lock:
            self.used = time.time()
            if not self.closed:
                self.closed = self.finishing = True
                tail = self._tail()
                spans = SPEECH(tail) if len(tail) else []
                if spans:
                    self._q.put(tail[max(0, spans[0][0] - PAD):min(len(tail), spans[-1][1] + PAD)])
                self._q.put(_STOP)
        self._worker.join(timeout)
        drop(self.sid)
        if self.error:
            raise V.VoiceError("Writing it down failed.", 503) from self.error
        if self._worker.is_alive():
            self.cancelled = True
            raise V.VoiceError("Writing it down took too long.", 503)
        if self.cancelled:          # cancelled meanwhile: the text is missing pieces, so the browser falls back
            raise V.VoiceError("The dictation was stopped before it was written down.", 503)
        return self.text

    def cancel(self):
        """Nothing more is transcribed; the session goes."""
        self.cancelled = self.closed = True
        self._q.put(_STOP)
        drop(self.sid)


_sessions, _reg = {}, threading.Lock()


def start(hint=""):
    """A new dictation -> its id. Sessions left idle (a closed tab, a lost connection) go first."""
    now = time.time()
    with _reg:
        stale = [_sessions.pop(s) for s, d in list(_sessions.items()) if now - d.used >= IDLE_S and not d.finishing]
    for d in stale:
        d.cancel()
    d = Dictation(hint)
    d.sid = secrets.token_urlsafe(8)
    with _reg:
        _sessions[d.sid] = d
    return d.sid


def get(sid):
    with _reg:
        d = _sessions.get(sid or "")
    if not d:
        raise V.VoiceError("That dictation has ended.", 404)
    return d


def drop(sid):
    with _reg:
        _sessions.pop(sid, None)
