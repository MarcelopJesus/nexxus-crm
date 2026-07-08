// api.js — cliente HTTP + estado de sessão.
(function () {
  const TOKEN_KEY = 'nexxus_token';
  const state = { token: localStorage.getItem(TOKEN_KEY) || null, user: null };
  const base = ''; // mesma origem

  async function req(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== '/api/auth/admin/login') { logout(); }
    return { ok: res.ok, status: res.status, data };
  }
  function setToken(t) { state.token = t; if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
  function logout() { setToken(null); state.user = null; location.hash = '#/login'; }

  window.API = {
    state, setToken, logout,
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    patch: (p, b) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
  };
})();
