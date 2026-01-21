export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return cors(await handleSubmit(request, env));
    }

    if (url.pathname === "/api/results" && request.method === "GET") {
      return cors(await handleResults(env));
    }

    return cors(new Response("Not found", { status: 404 }));
  }
};

function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*"); // or restrict to your GitHub Pages domain
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

async function handleSubmit(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "BAD_JSON" }, 400);
  }

  const errors = validate(payload);
  if (errors.length) return json({ ok: false, error: "VALIDATION_FAILED", details: errors }, 422);

  // Window ID (update if you change dates)
  const windowId = "2026-01-03_to_2026-02-02";
  const dedupeKey = await sha256(`${payload.voter_id}|${payload.schema_version}|${windowId}`);

  const existing = await env.DB.prepare(
    "SELECT receipt_id FROM submissions WHERE dedupe_key = ? LIMIT 1"
  ).bind(dedupeKey).first();

  if (existing?.receipt_id) {
    return json({ ok: true, receipt_id: existing.receipt_id, counted: false, message: "Duplicate detected (already counted)." }, 200);
  }

  const receiptId = "r_" + (await sha256(dedupeKey)).slice(0, 8);
  const now = new Date().toISOString();
  const region = payload?.context?.region || "Unknown";

  await env.DB.prepare(
    "INSERT INTO submissions (receipt_id, dedupe_key, created_utc, region, payload_json) VALUES (?,?,?,?,?)"
  ).bind(receiptId, dedupeKey, now, region, JSON.stringify(payload)).run();

  await updateAggregates(env.DB, payload);

  // OPTIONAL (Phase 2): Malcolm AI assist
  // Keep MALCOLM_TOKEN only in env vars, never in browser.
  // await sendToMalcolm(env, payload, receiptId);

  return json({ ok: true, receipt_id: receiptId, counted: true, message: "Submission received and counted." }, 200);
}

async function handleResults(env) {
  const aggRows = await env.DB.prepare("SELECT k, v FROM aggregates").all();
  const agg = Object.fromEntries((aggRows.results || []).map(r => [r.k, r.v]));

  const total = agg.total_submissions_counted || 0;
  const approve = agg.approve_interim_yes || 0;
  const prefer = agg.prefer_open_contest_yes || 0;
  const both = agg.both_selected || 0;
  const neither = agg.neither_selected || 0;

  const approvalRate = total ? Math.round((approve / total) * 1000) / 10 : null;
  const preferRate = total ? Math.round((prefer / total) * 1000) / 10 : null;

  const regions = await env.DB.prepare("SELECT region, total, approve_yes FROM region_counts").all();
  const regional_balance = (regions.results || []).map(r => ({
    region: r.region,
    submissions_counted: r.total,
    approve_rate_percent: r.total ? Math.round((r.approve_yes / r.total) * 1000) / 10 : null
  }));

  return json({
    last_updated_utc: new Date().toISOString(),
    window: { open: "2026-01-03", close: "2026-02-02", timezone: "America/Los_Angeles" },
    ballot: {
      total_submissions_counted: total,
      approve_interim_yes: approve,
      prefer_open_contest_yes: prefer,
      both_selected: both,
      neither_selected: neither,
      approval_rate_percent: approvalRate,
      prefer_open_rate_percent: preferRate
    },
    regional_balance,
    malcolm_insights: null
  }, 200);
}

function validate(p) {
  const e = [];
  if (!p?.schema_version) e.push("Missing schema_version");
  if (!p?.created_utc) e.push("Missing created_utc");
  if (!p?.voter_id) e.push("Missing voter_id");
  if (!p?.context?.region) e.push("Missing context.region");
  if (!p?.context?.country_or_territory) e.push("Missing context.country_or_territory");
  return e;
}

async function updateAggregates(DB, p) {
  const approve = !!p?.ballot_track_a?.approve_interim_masculine_regent;
  const prefer = !!p?.ballot_track_a?.prefer_open_contest_in_approx_90_days;
  const both = approve && prefer;
  const neither = !approve && !prefer;

  await inc(DB, "total_submissions_counted");
  if (approve) await inc(DB, "approve_interim_yes");
  if (prefer) await inc(DB, "prefer_open_contest_yes");
  if (both) await inc(DB, "both_selected");
  if (neither) await inc(DB, "neither_selected");

  const region = p?.context?.region || "Unknown";
  await DB.prepare(
    "INSERT INTO region_counts (region, total, approve_yes) VALUES (?,1,?) " +
    "ON CONFLICT(region) DO UPDATE SET total = total + 1, approve_yes = approve_yes + ?"
  ).bind(region, approve ? 1 : 0, approve ? 1 : 0).run();
}

async function inc(DB, key) {
  await DB.prepare(
    "INSERT INTO aggregates (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
  ).bind(key).run();
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
