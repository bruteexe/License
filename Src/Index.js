// src/index.js - Cloudflare Worker with D1 binding and Zerads Shortlink API
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Helper: D1 queries
    async function runQuery(sql, params = []) {
      const stmt = env.DB.prepare(sql);
      return params.length ? await stmt.bind(...params).run() : await stmt.run();
    }
    async function firstRow(sql, params = []) {
      const stmt = env.DB.prepare(sql);
      return params.length ? await stmt.bind(...params).first() : await stmt.first();
    }

    // Helper: Generate Zerads shortlink
    async function generateShortlink(targetUrl) {
      const escapedUrl = targetUrl.replace(/&/g, '@@');
      const apiUrl = `https://zerads.com/linkapi.php?user=Brute&url=${escapedUrl}&adsnum=1`;
      const response = await fetch(apiUrl);
      const short = await response.text();
      return `https://zerads.com/${short.trim()}`;
    }

    // ---------- Serve HTML frontend ----------
    if (path === "/" || path === "/index.html") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>License Generator</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
        button { background-color: #007bff; color: white; padding: 12px 24px; border: none; border-radius: 5px; font-size: 18px; cursor: pointer; margin: 10px; }
        button:disabled { background-color: #ccc; cursor: not-allowed; }
        .hidden { display: none; }
        .error { color: red; }
        .success { color: green; }
        .progress { background-color: #e9ecef; padding: 10px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <h1>License Generator</h1>
    <p>You need to complete <strong>5 ads</strong> to get a 1-hour license.</p>
    <button id="startBtn">Start & Watch Ads</button>
    <div id="loading" class="hidden">⏳ Setting up...</div>
    <div id="progress" class="progress hidden"></div>
    <div id="result"></div>

    <script>
        const API_BASE = window.location.origin;
        let currentToken = null;

        async function getUserId() {
            let uid = localStorage.getItem('user_id');
            if (!uid) {
                uid = 'user_' + Math.random().toString(36).substring(2, 15);
                localStorage.setItem('user_id', uid);
            }
            return uid;
        }

        async function checkStatus(token) {
            const res = await fetch(API_BASE + '/status?token=' + token);
            return res.json();
        }

        document.getElementById('startBtn').onclick = async () => {
            const btn = document.getElementById('startBtn');
            const loading = document.getElementById('loading');
            btn.disabled = true;
            loading.classList.remove('hidden');

            const user_id = await getUserId();
            try {
                const res = await fetch(API_BASE + '/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                currentToken = data.token;
                localStorage.setItem('session_token', currentToken);
                loading.classList.add('hidden');
                document.getElementById('progress').classList.remove('hidden');
                document.getElementById('progress').innerHTML = 'Opening ad... Complete 5 ads.';
                window.location.href = data.shortlink;
            } catch (err) {
                loading.classList.add('hidden');
                document.getElementById('result').innerHTML = '<div class="error">Error: ' + err.message + '</div>';
                btn.disabled = false;
            }
        };

        const urlParams = new URLSearchParams(window.location.search);
        const tokenFromUrl = urlParams.get('token');
        const licenseFromUrl = urlParams.get('license');
        
        if (licenseFromUrl && tokenFromUrl) {
            document.getElementById('result').innerHTML = '<div class="success"><strong>✅ License Key:</strong><br><code>' + licenseFromUrl + '</code><br><button onclick="navigator.clipboard.writeText(\\'' + licenseFromUrl + '\\')">Copy</button></div>';
            document.getElementById('progress').classList.add('hidden');
            localStorage.removeItem('session_token');
        } else if (tokenFromUrl) {
            document.getElementById('progress').classList.remove('hidden');
            document.getElementById('progress').innerHTML = 'Checking ad completion...';
            checkStatus(tokenFromUrl).then(data => {
                if (data.completed) {
                    document.getElementById('result').innerHTML = '<div class="success"><strong>✅ License Key:</strong><br><code>' + data.license_key + '</code><br><button onclick="navigator.clipboard.writeText(\\'' + data.license_key + '\\')">Copy</button></div>';
                    document.getElementById('progress').classList.add('hidden');
                    localStorage.removeItem('session_token');
                } else if (data.next_url) {
                    document.getElementById('progress').innerHTML = 'Ad ' + data.clicks_done + '/5 completed. Loading next ad...';
                    window.location.href = data.next_url;
                } else {
                    document.getElementById('result').innerHTML = '<div class="error">Failed: ' + (data.error || 'Unknown') + '</div>';
                }
            });
        }

        window.addEventListener('load', () => {
            const token = localStorage.getItem('session_token');
            if (token && !tokenFromUrl) {
                document.getElementById('startBtn').disabled = true;
                document.getElementById('progress').classList.remove('hidden');
                document.getElementById('progress').innerHTML = 'Session in progress. <button onclick="window.location.href=\\"/status-page?token=' + token + '\\"">Resume</button>';
            }
        });
    </script>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // ---------- API: /start - Create session and first shortlink ----------
    if (path === "/start" && request.method === "POST") {
      try {
        const { user_id } = await request.json();
        if (!user_id) return new Response(JSON.stringify({ error: "user_id required" }), { status: 400 });
        const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const token = crypto.randomUUID();

        await runQuery(
          "INSERT INTO pending_sessions (session_token, user_id, ip_address, clicks_needed, clicks_done, status) VALUES (?, ?, ?, 5, 0, 'pending')",
          [token, user_id, ip]
        );

        const callbackUrl = `${url.origin}/ad-callback?token=${token}&step=1`;
        const shortlink = await generateShortlink(callbackUrl);
        
        return new Response(JSON.stringify({ token, shortlink }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ---------- API: /ad-callback - After user completes an ad ----------
    if (path === "/ad-callback") {
      const token = url.searchParams.get("token");
      const step = parseInt(url.searchParams.get("step") || "1");
      if (!token) return new Response("Missing token", { status: 400 });

      const session = await firstRow(
        "SELECT clicks_done, clicks_needed, status FROM pending_sessions WHERE session_token = ?",
        [token]
      );
      if (!session) return new Response("Session not found", { status: 404 });
      if (session.status === "completed") {
        const lic = await firstRow("SELECT license_key FROM pending_sessions WHERE session_token = ?", [token]);
        return Response.redirect(`${url.origin}?token=${token}&license=${lic.license_key}`, 302);
      }

      const newDone = session.clicks_done + 1;
      await runQuery("UPDATE pending_sessions SET clicks_done = ? WHERE session_token = ?", [newDone, token]);

      if (newDone >= session.clicks_needed) {
        const licenseKey = crypto.randomUUID();
        const { user_id, ip_address } = await firstRow(
          "SELECT user_id, ip_address FROM pending_sessions WHERE session_token = ?",
          [token]
        );
        await runQuery(
          "INSERT INTO licenses (license_key, user_id, request_ip, created_at) VALUES (?, ?, ?, ?)",
          [licenseKey, user_id, ip_address, new Date().toISOString()]
        );
        await runQuery(
          "UPDATE pending_sessions SET status = 'completed', license_key = ? WHERE session_token = ?",
          [licenseKey, token]
        );
        return Response.redirect(`${url.origin}?token=${token}&license=${licenseKey}`, 302);
      } else {
        const callbackUrl = `${url.origin}/ad-callback?token=${token}&step=${newDone + 1}`;
        const nextShortlink = await generateShortlink(callbackUrl);
        return Response.redirect(nextShortlink, 302);
      }
    }

    // ---------- API: /status - Check session progress ----------
    if (path === "/status") {
      const token = url.searchParams.get("token");
      if (!token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400 });
      const session = await firstRow(
        "SELECT clicks_done, clicks_needed, status, license_key FROM pending_sessions WHERE session_token = ?",
        [token]
      );
      if (!session) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
      if (session.status === "completed") {
        return new Response(JSON.stringify({ completed: true, license_key: session.license_key }), { status: 200 });
      } else {
        return new Response(JSON.stringify({ completed: false, clicks_done: session.clicks_done, clicks_needed: session.clicks_needed }), { status: 200 });
      }
    }

    // ---------- API: /verify - For Python script ----------
    if (path === "/verify" && request.method === "POST") {
      try {
        const { license_key, user_id } = await request.json();
        const currentIp = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
        const lic = await firstRow(
          "SELECT user_id, request_ip, created_at FROM licenses WHERE license_key = ?",
          [license_key]
        );
        if (!lic) return new Response(JSON.stringify({ valid: false, error: "License not found" }), { status: 403 });
        if (lic.user_id !== user_id) return new Response(JSON.stringify({ valid: false, error: "User ID mismatch" }), { status: 403 });
        const createdAt = new Date(lic.created_at);
        if (Date.now() - createdAt.getTime() > 3600000) {
          await runQuery("DELETE FROM licenses WHERE license_key = ?", [license_key]);
          return new Response(JSON.stringify({ valid: false, error: "License expired" }), { status: 403 });
        }
        if (lic.request_ip !== currentIp) {
          await runQuery("DELETE FROM licenses WHERE license_key = ?", [license_key]);
          return new Response(JSON.stringify({ valid: false, error: "IP mismatch" }), { status: 403 });
        }
        const remaining = Math.floor((createdAt.getTime() + 3600000 - Date.now()) / 1000);
        return new Response(JSON.stringify({ valid: true, remaining_seconds: remaining }), { status: 200 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ---------- API: /health ----------
    if (path === "/health") {
      return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  }
};
