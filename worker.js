export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS (allow your GitHub Pages site + allow * as fallback) ---
    // If you want strict CORS later, replace "*" with your exact domain.
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    };

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // Basic health check
      if (url.pathname === "/healthz") {
        return new Response(JSON.stringify({ ok: true, service: "sovereign-vote", ts: new Date().toISOString() }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Ensure DB binding exists
      if (!env.DB) {
        return new Response(JSON.stringify({ ok: false, error: "DB_BINDING_MISSING", hint: "Add D1 binding named 'DB' in Worker settings." }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Route: submit
      if (url.pathname === "/api/submit" && request.method === "POST") {
        const out = await handleSubmit(request, env);
        return new Response(JSON.stringify(out.body, null, 2), {
          status: out.status,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Route: results
      if (url.pathname === "/api/results" && request.method === "GET") {
        const out = await handleResults(env);
        return new Response(JSON.stringify(out.body, null, 2), {
          status: out.status,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ ok: false, error: "NOT_FOUND" }, null, 2), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: "UNHANDLED", message: String(err?.message || err) }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};

// ------------------------
// Core handlers
// ------------------------

async function handleSubmit(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: { ok: false, error: "BAD_JSON" } };
  }

  const errors = validatePayload(payload);
  if (errors.length) {
    return { status: 422, body: { ok: false, error: "VALIDATION_FAILED", details: errors } };
  }

  // Window ID (update if you change dates)
  const windowId = "2026-01-03_to_2026-02-02";
  const dedupeKey = await sha256(`${payload.voter_id}|${payload.schema_version}|${windowId}`);

  // Ensure tables exist (safe to call repeatedly)
  await ensureSchema(env.DB);

  // Check duplicate
  const existing = await env.DB
    .prepare("SELECT receipt_id FROM submissions WHERE dedupe_key = ? LIMIT 1")
    .bind(dedupeKey)
    .first();

  if (existing?.receipt_id) {
    return {
      status: 200,
      body: {
        ok: true,
        receipt_id: existing.receipt_id,
        counted: false,
        message: "Duplicate detected (already counted)."
      }
    };
  }

  const receiptId = "r_" + (await sha256(dedupeKey)).slice(0, 8);
  const now = new Date().toISOString();
  const region = payload.context.region || "Unknown";

  // Store raw submission (append-only)
  await env.DB
    .prepare("INSERT INTO submissions (receipt_id, dedupe_key, created_utc, region, payload_json) VALUES (?,?,?,?,?)")
    .bind(receiptId, dedupeKey, now, region, JSON.stringify(payload))
    .run();

  // Update aggregates deterministically
  await updateAggregates(env.DB, payload);

  return {
    status: 200,
    body: { ok: true, receipt_id: receiptId, counted: true, message: "Submission received and counted." }
  };
}

async function handleResults(env) {
  await ensureSchema(env.DB);

  const aggRows = await env.DB.prepare("SELECT k, v FROM aggregates").all();
  const agg = Object.fromEntries((aggRows.results || []).map(r => [r.k, r.v]));

  const total = agg.total_submissions_counted || 0;
  const approve = agg.approve_interim_yes || 0;
  const prefer = agg.prefer_open_contest_yes || 0;
  const both = agg.both_selected || 0;
  const neither = agg.neither_selected || 0;

  const approvalRate = total ? round1((approve / total) * 100) : null;
  const preferRate = total ? round1((prefer / total) * 100) : null;

  const regions = await env.DB.prepare("SELECT region, total, approve_yes FROM region_counts").all();
  const regional_balance = (regions.results || []).map(r => ({
    region: r.region,
    submissions_counted: r.total,
    approve_rate_percent: r.total ? round1((r.approve_yes / r.total) * 100) : null
  }));

  return {
    status: 200,
    body: {
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
    }
  };
}

// ------------------------
// Utilities
// ------------------------

function validatePayload(p) {
  const e = [];
  if (!p || typeof p !== "object") return ["Payload must be JSON object"];

  if (!p.schema_version) e.push("Missing schema_version");
  if (!p.created_utc) e.push("Missing created_utc");
  if (!p.voter_id) e.push("Missing voter_id");

  if (!p.context || typeof p.context !== "object") e.push("Missing context object");
  if (!p.context?.region) e.push("Missing context.region");
  if (!p.context?.country_or_territory) e.push("Missing context.country_or_territory");

  // Soft check: consent recommended but not enforced here (you can enforce if desired)
  return e;
}

async function ensureSchema(DB) {
  // These are idempotent.
  await DB.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      receipt_id TEXT PRIMARY KEY,
      dedupe_key TEXT UNIQUE,
      created_utc TEXT,
      region TEXT,
      payload_json TEXT
    );
    CREATE TABLE IF NOT EXISTS aggregates (
      k TEXT PRIMARY KEY,
      v INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS region_counts (
      region TEXT PRIMARY KEY,
      total INTEGER NOT NULL,
      approve_yes INTEGER NOT NULL
    );
  `);
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

  // Ensure row exists
  await DB.prepare(
    "INSERT INTO region_counts (region, total, approve_yes) VALUES (?, 0, 0) ON CONFLICT(region) DO NOTHING"
  ).bind(region).run();

  // Update region
  await DB.prepare(
    "UPDATE region_counts SET total = total + 1, approve_yes = approve_yes + ? WHERE region = ?"
  ).bind(approve ? 1 : 0, region).run();
}

async function inc(DB, key) {
  await DB.prepare(
    "INSERT INTO aggregates (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
  ).bind(key).run();
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
