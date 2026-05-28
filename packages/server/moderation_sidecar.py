#!/usr/bin/env python3
"""
Void moderation sidecar — runs a small multi-label toxicity classifier on the
Jetson's GPU and exposes a tiny localhost HTTP API the bun server calls.

Why a sidecar: onnxruntime-node's prebuilt aarch64 binary crashes on the
Jetson's Tegra cores (cpuinfo bug), and CPU/WASM inference wastes the Orin's
GPU. PyTorch (NVIDIA's JetPack wheel) runs the model on CUDA reliably.

Contract (matches packages/server/src/moderation-model.ts):
  GET  /health   -> 200 {"ok": true, "device": "...", "labels": [...]}
  POST /classify {"text": "..."} -> 200 {"scores": {"<label>": <prob>, ...}}

Env:
  VOID_MOD_PORT   listen port (default 8788), bound to 127.0.0.1 only
  VOID_MOD_MODEL  HF model id (default unitary/toxic-bert)
  HF_HOME         model cache dir (set by the systemd unit to persist downloads)
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL = os.environ.get("VOID_MOD_MODEL", "unitary/toxic-bert")
PORT = int(os.environ.get("VOID_MOD_PORT", "8788"))
MAX_TOKENS = 128

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[voidmod] loading {MODEL} on {device} ...", flush=True)
_tokenizer = AutoTokenizer.from_pretrained(MODEL)
_model = AutoModelForSequenceClassification.from_pretrained(MODEL).to(device).eval()
LABELS = [_model.config.id2label[i] for i in range(_model.config.num_labels)]
# Inference is serialized: torch + the GIL gain nothing from parallel GPU calls
# at our QPS, and a lock keeps CUDA usage simple and safe.
_lock = threading.Lock()


@torch.no_grad()
def classify(text: str) -> dict:
    enc = _tokenizer(
        text, return_tensors="pt", truncation=True, max_length=MAX_TOKENS
    ).to(device)
    probs = torch.sigmoid(_model(**enc).logits[0]).tolist()
    return {label: float(p) for label, p in zip(LABELS, probs)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"ok": True, "device": device, "labels": LABELS})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/classify":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", 0))
            text = json.loads(self.rfile.read(n)).get("text", "")
        except Exception:
            self._send(400, {"error": "bad request"})
            return
        if not isinstance(text, str) or text == "":
            self._send(400, {"error": "missing text"})
            return
        with _lock:
            scores = classify(text)
        self._send(200, {"scores": scores})

    def log_message(self, *args) -> None:  # silence per-request stderr logging
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[voidmod] listening on 127.0.0.1:{PORT} device={device} labels={LABELS}", flush=True)
    server.serve_forever()
