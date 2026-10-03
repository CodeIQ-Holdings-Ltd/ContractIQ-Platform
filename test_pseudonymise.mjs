/* Pseudonymisation tests — run: node test_pseudonymise.mjs
   The functions are lifted out of contractiq.jsx by name so the test can
   never drift from the shipped source: if the source changes, this runs
   against the change. */
import fs from "node:fs";

const src = fs.readFileSync(new URL("./contractiq.jsx", import.meta.url), "utf8");
function lift(name, kind) {
  const start = src.indexOf(`${kind} ${name}`);
  if (start === -1) throw new Error(`${name} not found in contractiq.jsx`);
  if (kind === "const") return src.slice(start, src.indexOf("\n", start) + 1);
  // brace-match a function declaration
  let i = src.indexOf("{", start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) break; }
  }
  return src.slice(start, j + 1) + "\n";
}

const code = [
  lift("newPseudoMap", "const"),
  lift("escapeRx", "const"),
  lift("pseudoLabel", "function"),
  lift("pseudonymiseTranscript", "function"),
  lift("rehydrate", "function"),
].join("\n") + "\nexport { newPseudoMap, pseudonymiseTranscript, rehydrate, pseudoLabel };";

const mod = await import("data:text/javascript," + encodeURIComponent(code));
const { newPseudoMap, pseudonymiseTranscript, rehydrate, pseudoLabel } = mod;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); fail++; }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "expected true"); };

const TRANSCRIPT = [
  "Alice Whitfield: Morning. On the 2025 uplift — we waived it after the outage.",
  "Raj Sharma: Alice, was that ever put in writing?",
  "Alice Whitfield: No. Ring me on 020 7946 0812 or mail alice.whitfield@supplier.example if you need it.",
  "Raj Sharma: Understood. Raj will chase the paperwork.",
].join("\n");
const SPEAKERS = ["Alice Whitfield", "Raj Sharma"];

console.log("\nPseudonymisation");

t("speaker names are replaced with stable labels", () => {
  const r = pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, newPseudoMap());
  eq(r.speakers[0], "Participant A");
  eq(r.speakers[1], "Participant B");
});

t("no real name survives anywhere in the outgoing text", () => {
  const r = pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, newPseudoMap());
  for (const n of ["Alice Whitfield", "Alice", "Whitfield", "Raj Sharma", "Raj", "Sharma"]) {
    ok(!new RegExp("\\b" + n + "\\b").test(r.text), `"${n}" still present in: ${r.text}`);
  }
});

t("a first name used alone later is caught too", () => {
  const r = pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, newPseudoMap());
  ok(/Participant B: Participant A, was that ever put in writing\?/.test(r.text), r.text);
});

t("e-mail addresses are tokenised", () => {
  const r = pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, newPseudoMap());
  ok(!/alice\.whitfield@supplier\.example/.test(r.text), "raw e-mail survived");
  ok(/Email 1/.test(r.text), "no e-mail token emitted");
});

t("phone numbers are tokenised", () => {
  const r = pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, newPseudoMap());
  ok(!/020 7946 0812/.test(r.text), "raw phone number survived");
  ok(/Phone 1/.test(r.text), "no phone token emitted");
});

t("contract money and dates are NOT mangled", () => {
  const r = pseudonymiseTranscript(
    "Alice Whitfield: The annual charge is £1,450,000 and it ends 31 March 2027. Notice is 90 days.",
    ["Alice Whitfield"], newPseudoMap());
  ok(/£1,450,000/.test(r.text), "annual value was altered: " + r.text);
  ok(/31 March 2027/.test(r.text), "end date was altered: " + r.text);
  ok(/90 days/.test(r.text), "notice period was altered: " + r.text);
});

t("the same person keeps the same label across two transcripts", () => {
  const map = newPseudoMap();
  const a = pseudonymiseTranscript("Alice Whitfield: one", ["Alice Whitfield"], map);
  const b = pseudonymiseTranscript("Raj Sharma: two\nAlice Whitfield: three", ["Raj Sharma", "Alice Whitfield"], map);
  eq(a.speakers[0], "Participant A");
  eq(b.speakers[1], "Participant A", "Alice changed label between meetings —");
  eq(b.speakers[0], "Participant B");
});

t("labels stay unique past 26 participants", () => {
  eq(pseudoLabel(0), "Participant A");
  eq(pseudoLabel(25), "Participant Z");
  eq(pseudoLabel(26), "Participant A2");
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(pseudoLabel(i));
  eq(seen.size, 60, "duplicate labels generated —");
});

t("unattributed speech is left alone, not given an identity", () => {
  const r = pseudonymiseTranscript("Unattributed: someone coughed", ["Unattributed"], newPseudoMap());
  eq(r.speakers[0], "Unattributed");
});

console.log("\nRe-identification (display only)");

t("rehydrate puts the real names back", () => {
  const map = newPseudoMap();
  const r = pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, map);
  const back = rehydrate(r.text, map);
  ok(/Alice Whitfield/.test(back), "name not restored: " + back);
  ok(/Raj Sharma/.test(back), "name not restored: " + back);
  ok(/020 7946 0812/.test(back), "phone not restored");
  ok(/alice\.whitfield@supplier\.example/.test(back), "e-mail not restored");
});

t("rehydrate walks a whole analysis payload", () => {
  const map = newPseudoMap();
  pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, map);
  const payload = {
    summary: "Participant A waived the uplift.",
    points: [{ insight: "Participant A conceded", source: "Q3.vtt — Participant A" }],
    keyPersonRisk: ["Participant B holds the relationship"],
    confidence: 38, ok: true, nothing: null,
  };
  const out = rehydrate(payload, map);
  eq(out.summary, "Alice Whitfield waived the uplift.");
  eq(out.points[0].source, "Q3.vtt — Alice Whitfield");
  eq(out.keyPersonRisk[0], "Raj Sharma holds the relationship");
  eq(out.confidence, 38, "a number was corrupted —");
  eq(out.ok, true);
  eq(out.nothing, null);
});

t("with no map, rehydrate returns the text untouched (no crash)", () => {
  eq(rehydrate("Participant A said so", undefined), "Participant A said so");
  eq(rehydrate("Participant A said so", newPseudoMap()), "Participant A said so");
});

t("the map is not something the record can carry", () => {
  // The map object is deliberately separate from the document; this asserts
  // the shape the app relies on — a doc gets flags, never the mapping.
  const map = newPseudoMap();
  const r = pseudonymiseTranscript(TRANSCRIPT, SPEAKERS, map);
  const doc = { name: "Q3.vtt", text: r.text, speakers: r.speakers, pseudonymised: true,
                pseudonymisedCount: Object.keys(map.toReal).length };
  const json = JSON.stringify(doc);
  for (const n of ["Alice", "Whitfield", "Raj", "Sharma", "toReal", "toPseudo"]) {
    ok(!json.includes(n), `"${n}" would be written to the database in: ${json}`);
  }
  ok(doc.pseudonymisedCount >= 4, "count looks wrong: " + doc.pseudonymisedCount);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
