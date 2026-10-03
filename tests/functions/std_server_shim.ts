export function serve(handler: (req: Request) => Response | Promise<Response>) {
  return Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8787), onListen: () => {} }, handler);
}
