export const SHELL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Garbanzo configuration</title><link rel="stylesheet" href="/shell.css"></head>
<body><main><h1>Garbanzo configuration</h1><p>Paste the one-time token printed in your terminal.</p>
<form id="login"><label for="token">Session token</label><input id="token" type="password" autocomplete="off" required><button>Connect</button></form>
<section hidden id="console"><h2>Config API</h2><p>Available endpoints</p><ul>
<li>GET /api/state</li><li>GET, PUT /api/config</li><li>PUT /api/config-file/:name</li>
<li>POST /api/validate</li><li>GET /api/export</li><li>POST /api/import</li>
<li>POST /api/wizard</li><li>POST /api/apply</li></ul><pre id="output"></pre></section>
</main><script src="/shell.js" defer></script></body></html>`;

export const SHELL_CSS = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0}main{max-width:48rem;margin:4rem auto;padding:1rem}form{display:grid;gap:.75rem;max-width:30rem}input,button{font:inherit;padding:.7rem}pre{white-space:pre-wrap}`;

export const SHELL_JS = `const form=document.querySelector('#login');const token=document.querySelector('#token');const panel=document.querySelector('#console');const output=document.querySelector('#output');let session='';form.addEventListener('submit',async(event)=>{event.preventDefault();const response=await fetch('/api/session',{method:'POST',headers:{Authorization:'Bearer '+token.value}});const body=await response.json();token.value='';if(!response.ok){output.textContent=body.error||'Authentication failed';return}session=body.token;form.hidden=true;panel.hidden=false;const state=await fetch('/api/state',{headers:{Authorization:'Bearer '+session}});output.textContent=JSON.stringify(await state.json(),null,2)});`;

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
