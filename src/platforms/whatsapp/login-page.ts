export const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Garbanzo WhatsApp Login</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f4ef;
      color: #1c1b18;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }

    main {
      width: min(100%, 520px);
      background: #ffffff;
      border: 1px solid #ddd7cb;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 16px 48px rgb(28 27 24 / 12%);
    }

    h1 {
      margin: 0 0 18px;
      font-size: 1.4rem;
      line-height: 1.25;
    }

    .tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 18px;
    }

    button {
      min-height: 42px;
      border: 1px solid #b9ad9b;
      border-radius: 6px;
      background: #f9f7f2;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    button[aria-selected="true"],
    button[type="submit"] {
      background: #255c46;
      border-color: #255c46;
      color: #ffffff;
    }

    .panel[hidden] {
      display: none;
    }

    .qr-frame {
      display: grid;
      place-items: center;
      min-height: 300px;
      border: 1px dashed #b9ad9b;
      border-radius: 8px;
      background: #fbfaf7;
      padding: 18px;
    }

    img {
      width: min(100%, 280px);
      height: auto;
    }

    .status {
      margin-top: 14px;
      min-height: 24px;
      font-weight: 600;
    }

    form {
      display: grid;
      gap: 12px;
    }

    label {
      display: grid;
      gap: 6px;
      font-weight: 600;
    }

    input {
      min-height: 44px;
      border: 1px solid #b9ad9b;
      border-radius: 6px;
      padding: 0 12px;
      font: inherit;
    }

    code {
      display: block;
      min-height: 44px;
      margin-top: 14px;
      padding: 12px;
      border-radius: 6px;
      background: #efe9dd;
      color: #1c1b18;
      font-size: 1.2rem;
      letter-spacing: 0;
      text-align: center;
      overflow-wrap: anywhere;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        background: #191816;
        color: #f6f1e8;
      }

      main {
        background: #24221f;
        border-color: #4c463d;
      }

      button,
      input,
      .qr-frame {
        background: #1f1d1a;
        border-color: #625a4f;
        color: #f6f1e8;
      }

      code {
        background: #312d28;
        color: #f6f1e8;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>WhatsApp Login</h1>
    <div class="tabs" role="tablist" aria-label="WhatsApp login methods">
      <button id="qr-tab" type="button" role="tab" aria-selected="true" aria-controls="qr-panel">Scan QR</button>
      <button id="pair-tab" type="button" role="tab" aria-selected="false" aria-controls="pair-panel">Pair with code</button>
    </div>

    <section id="qr-panel" class="panel" role="tabpanel" aria-labelledby="qr-tab">
      <div class="qr-frame">
        <img id="qr" alt="WhatsApp login QR code" hidden>
        <span id="qr-placeholder">Waiting for QR...</span>
      </div>
      <div id="status" class="status" aria-live="polite">Pending</div>
    </section>

    <section id="pair-panel" class="panel" role="tabpanel" aria-labelledby="pair-tab" hidden>
      <form id="pair-form">
        <label>
          Phone number
          <input id="phone-number" name="phoneNumber" inputmode="tel" autocomplete="tel" required>
        </label>
        <button type="submit">Request pairing code</button>
      </form>
      <code id="pair-code" aria-live="polite"></code>
    </section>
  </main>

  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get('token') || '';
    const qrTab = document.getElementById('qr-tab');
    const pairTab = document.getElementById('pair-tab');
    const qrPanel = document.getElementById('qr-panel');
    const pairPanel = document.getElementById('pair-panel');
    const qr = document.getElementById('qr');
    const qrPlaceholder = document.getElementById('qr-placeholder');
    const status = document.getElementById('status');
    const pairForm = document.getElementById('pair-form');
    const pairCode = document.getElementById('pair-code');

    function selectTab(name) {
      const showQr = name === 'qr';
      qrTab.setAttribute('aria-selected', String(showQr));
      pairTab.setAttribute('aria-selected', String(!showQr));
      qrPanel.hidden = !showQr;
      pairPanel.hidden = showQr;
    }

    qrTab.addEventListener('click', () => selectTab('qr'));
    pairTab.addEventListener('click', () => selectTab('pair'));

    const events = new EventSource('/whatsapp/login/stream?token=' + encodeURIComponent(token));
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.qrDataUrl) {
        qr.src = payload.qrDataUrl;
        qr.hidden = false;
        qrPlaceholder.hidden = true;
      } else {
        qr.removeAttribute('src');
        qr.hidden = true;
        qrPlaceholder.hidden = false;
      }

      status.textContent = payload.state === 'linked' ? 'Linked ✓' : 'Pending';
    };
    events.onerror = () => {
      status.textContent = 'Connection interrupted';
    };

    pairForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      pairCode.textContent = '';

      const phoneNumber = document.getElementById('phone-number').value;
      const response = await fetch('/whatsapp/login/pair?token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      });
      const payload = await response.json();
      pairCode.textContent = response.ok ? payload.code : payload.error;
    });
  </script>
</body>
</html>`;
