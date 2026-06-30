"""CORS + auth proxy for the ScadPad AI Chat, deployed on Modal.

ScadPad's chat (js/chat.js) is a browser PWA that talks to an OpenAI-compatible
chat-completions API. It cannot call the model "auto endpoints" directly because:

  1. CORS preflight — the browser sends an unauthenticated OPTIONS request that
     Modal proxy-auth rejects, and the auto endpoint does not return the CORS
     headers a cross-origin fetch needs.
  2. Secret exposure — calling the auto endpoint requires the Modal-Key /
     Modal-Secret proxy-auth pair, which we do not want to ship to every browser.

This app is a thin, *public* proxy (no Modal proxy-auth on it) that:

  - answers the CORS preflight (OPTIONS) with no auth,
  - checks a single `Authorization: Bearer <PROXY_API_KEY>` on real requests,
  - inspects the `model` field in the request body to route to the correct
    upstream auto endpoint,
  - stream-forwards the request to the upstream, adding the Modal-Key /
    Modal-Secret headers server-side.

So the browser only ever holds one bearer key and the proxy URL; the auto
endpoint's credentials stay here.

Deploy
------
1. Create the secret (the upstream Modal-Key/Modal-Secret come from the auto
   endpoint's proxy-auth token; PROXY_API_KEY is one you invent and paste into
   ScadPad's Chat settings):

     modal secret create gemma-proxy-secrets \
       PROXY_API_KEY=sk-scadpad-... \
       MODAL_KEY=wk-... \
       MODAL_SECRET=ws-...

2. (Optional) restrict CORS to your app origin by setting ALLOWED_ORIGINS in the
   same secret, e.g. ALLOWED_ORIGINS="https://elvinio.github.io". Defaults to "*".

3. Deploy:

     modal deploy modal/gemma_proxy.py

   Modal prints the public URL — paste it (without a trailing slash) into
   ScadPad → Chat settings → "Modal proxy URL", and the PROXY_API_KEY into
   "Modal API key".
"""

import json as _json
import os

import modal

# Map of model ID (sent by the client) to upstream auto endpoint URL.
# The proxy inspects the `model` field in the request body and forwards to the
# matching endpoint. Falls back to DEFAULT_UPSTREAM for unrecognised models.
UPSTREAMS = {
    'google/gemma-4-31B-it':  'https://elvinio--ep-gemma-4-31b-it-server.us-west.modal.direct',
    'Qwen/Qwen3.6-35B-A3B':   'https://elvinio--ep-qwen3-6-35b-a3b-server.ap-south.modal.direct',
}
DEFAULT_UPSTREAM = UPSTREAMS['google/gemma-4-31B-it']

app = modal.App("gemma-proxy")
image = modal.Image.debian_slim().pip_install("fastapi[standard]==0.115.*", "httpx==0.27.*")


def build_app():
    from fastapi import FastAPI, HTTPException, Request, Response
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import StreamingResponse
    from starlette.background import BackgroundTask
    import httpx

    web = FastAPI()
    origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
    web.add_middleware(
        CORSMiddleware,
        allow_origins=origins or ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # One shared client per upstream, lazily created and reused across requests
    # within the same container lifetime.
    clients: dict = {}

    def _get_client(upstream: str) -> httpx.AsyncClient:
        if upstream not in clients:
            clients[upstream] = httpx.AsyncClient(base_url=upstream, timeout=None)
        return clients[upstream]

    def _check_auth(request: Request) -> None:
        expected = os.environ["PROXY_API_KEY"]
        if request.headers.get("authorization") != f"Bearer {expected}":
            raise HTTPException(status_code=401, detail="Invalid or missing API key.")

    @web.api_route("/v1/{path:path}", methods=["GET", "POST", "OPTIONS"])
    async def proxy(path: str, request: Request):
        # CORS preflight: browsers send it without credentials, so it must not
        # require auth. CORSMiddleware adds the Access-Control-* headers.
        if request.method == "OPTIONS":
            return Response(status_code=204)

        _check_auth(request)

        body_bytes = await request.body()

        # Route to the correct upstream based on the `model` field in the body.
        try:
            model = _json.loads(body_bytes).get("model", "")
        except Exception:
            model = ""
        upstream = UPSTREAMS.get(model, DEFAULT_UPSTREAM)
        client = _get_client(upstream)

        upstream_req = client.build_request(
            request.method,
            f"/v1/{path}",
            params=request.query_params,
            content=body_bytes,
            headers={
                "Content-Type": request.headers.get("content-type", "application/json"),
                "Accept": request.headers.get("accept", "application/json"),
                "Modal-Key": os.environ["MODAL_KEY"],
                "Modal-Secret": os.environ["MODAL_SECRET"],
            },
        )
        upstream_resp = await client.send(upstream_req, stream=True)
        return StreamingResponse(
            upstream_resp.aiter_raw(),
            status_code=upstream_resp.status_code,
            media_type=upstream_resp.headers.get("content-type"),
            background=BackgroundTask(upstream_resp.aclose),
        )

    return web


@app.function(image=image, secrets=[modal.Secret.from_name("gemma-proxy-secrets")])
@modal.asgi_app()
def fastapi_app():
    return build_app()
