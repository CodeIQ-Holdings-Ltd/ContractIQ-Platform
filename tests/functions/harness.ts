// Test harness: runs an Edge Function for real (Deno.serve on a local port)
// with the network replaced by fakes of Supabase and Amazon Bedrock.
// Every outbound request is recorded so the tests can assert on it.
const realFetch = globalThis.fetch;
export const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];

type Fake = (url: URL, body: any, headers: Headers) => Response | Promise<Response> | null;
const fakes: Fake[] = [];
export const onRequest = (f: Fake) => fakes.push(f);

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(input as any, init);
  const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
  let body: any = text; try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => headers[k] = v);
  calls.push({ url: url.toString(), method: req.method, headers, body });
  for (const f of fakes) {
    const r = await f(url, body, req.headers);
    if (r) return r;
  }
  return new Response(JSON.stringify({ message: "no fake for " + url }), { status: 599 });
};

export const J = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let failures = 0, passes = 0;
export function check(name: string, ok: boolean, detail = "") {
  if (ok) { passes++; console.log("  PASS " + name); }
  else { failures++; console.log("  FAIL " + name + (detail ? "  — " + detail : "")); }
}
export function summary(label: string) {
  console.log(`${label}: ${passes} passed, ${failures} failed`);
  Deno.exit(failures ? 1 : 0);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
