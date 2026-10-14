export async function onRequest({ request }) {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, "https://apl-gym-license.apleng.workers.dev");
  const headers = new Headers(request.headers);
  headers.delete("host");
  // The Pages Function is a same-origin proxy for the browser. The upstream
  // Worker validates Origin against its own URL, so normalize Origin here.
  headers.set("Origin", "https://apl-gym-license.apleng.workers.dev");

  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return fetch(new Request(target, init));
}