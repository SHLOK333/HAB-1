"""0G Private Computer client: one decision per call, with its request ID.

The router is OpenAI-compatible (https://router-api.0g.ai/v1). Any failure (no
key, no network, timeout, HTTP error, an answer that is not one of the allowed
actions) raises ZgUnavailable. The caller must then hold a safe state; it must
never invent the decision itself.
"""
import base64, json, os, re, time

DECISION_MODEL = "0gm-1.0-35b-a3b"
VISION_MODEL = "qwen3-vl-plus"


class ZgUnavailable(Exception):
    pass


class Zg:
    def __init__(self, timeout_s=25):
        key = os.environ.get("ZG_PC_API_KEY", "").strip()
        self.base = os.environ.get("ZG_PC_BASE_URL", "https://router-api.0g.ai/v1").strip()
        self.client = None
        if key:
            from openai import OpenAI
            self.client = OpenAI(base_url=self.base, api_key=key, timeout=timeout_s, max_retries=0)

    def decide(self, model, system, user, allowed, image_jpeg=None):
        """Return (decision dict, meta dict). decision has "action" (one of allowed) and "reason"."""
        if self.client is None:
            raise ZgUnavailable("no ZG_PC_API_KEY on the Pi")
        content = user
        if image_jpeg is not None:
            content = [{"type": "text", "text": user},
                       {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(image_jpeg).decode()}}]
        t0 = time.time()
        try:
            raw = self.client.chat.completions.with_raw_response.create(
                model=model, temperature=0, max_tokens=200,
                # 0gm-1.0-35b-a3b thinks by default and spends all 200 tokens on reasoning,
                # leaving an empty answer (measured 6 Nov 2026); a checkpoint needs the answer.
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                messages=[{"role": "system", "content": system}, {"role": "user", "content": content}])
            resp = raw.parse()
        except Exception as e:                                   # network, auth, quota, timeout
            raise ZgUnavailable(f"{type(e).__name__}: {str(e)[:160]}")
        meta = {"model": model, "response_id": resp.id, "latency_ms": round((time.time() - t0) * 1000),
                "request_id": raw.headers.get("x-request-id") or raw.headers.get("request-id"),
                "headers": {k: v for k, v in raw.headers.items() if "id" in k.lower() or k.lower().startswith("x-0g")},
                "usage": resp.usage.model_dump() if resp.usage else None}
        text = resp.choices[0].message.content or ""
        m = re.search(r"\{.*\}", text, re.S)
        try:
            decision = json.loads(m.group(0)) if m else {}
        except ValueError:
            decision = {}
        if decision.get("action") not in allowed:
            raise ZgUnavailable(f"answer is not one of {allowed}: {text[:120]!r}")
        meta["raw_answer"] = text[:400]
        return {"action": decision["action"], "reason": str(decision.get("reason", ""))[:200]}, meta
