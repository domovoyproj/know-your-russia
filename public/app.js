/* KYR frontend — vanilla JS + Leaflet. No build step. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const api = (path, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      opts.body = JSON.stringify(opts.json);
    }
    return fetch(path, { ...opts, headers }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    });
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---- state ----------------------------------------------------------------
  const state = {
    token: localStorage.getItem("kyr_token") || null,
    user: JSON.parse(localStorage.getItem("kyr_user") || "null"),
    pick: null, // active pick callback while placing a point
  };
  const setAuth = (token, user) => {
    state.token = token; state.user = user;
    if (token) {
      localStorage.setItem("kyr_token", token);
      localStorage.setItem("kyr_user", JSON.stringify(user));
    } else {
      localStorage.removeItem("kyr_token");
      localStorage.removeItem("kyr_user");
    }
    renderNav();
  };

  // ---- map ------------------------------------------------------------------
  const map = L.map("map", { minZoom: 2, worldCopyJump: true }).setView([62, 94], 3);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap",
  }).addTo(map);

  const cluster = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 60 });
  map.addLayer(cluster);

  let loadTimer = null;
  const scheduleLoad = () => { clearTimeout(loadTimer); loadTimer = setTimeout(loadPoints, 250); };
  map.on("moveend zoomend", scheduleLoad);

  async function loadPoints() {
    if (state.pick) return; // don't churn markers while placing a point
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
    let points = [];
    try { points = await api(`/api/points?bbox=${bbox}`); } catch (e) { return; }
    cluster.clearLayers();
    const markers = points.map((p) => {
      const m = L.marker([p.lat, p.lng]);
      m.on("click", () => openMedia(p.id));
      return m;
    });
    cluster.addLayers(markers);
    $("#hint").textContent = `меток в области: ${points.length}`;
  }

  // ---- modal ----------------------------------------------------------------
  const modal = $("#modal");
  const modalBody = $("#modal-body");
  const openModal = (html) => { modalBody.innerHTML = html; modal.classList.remove("hidden"); };
  const closeModal = () => { modal.classList.add("hidden"); modalBody.innerHTML = ""; };
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.hasAttribute("data-close")) closeModal();
  });

  // ---- nav ------------------------------------------------------------------
  function renderNav() {
    const nav = $("#nav");
    if (state.user) {
      const admin = state.user.is_admin
        ? `<button id="nav-admin">Модерация</button>` : "";
      nav.innerHTML = `
        <button id="nav-upload" class="primary">+ Загрузить</button>
        <button id="nav-me">Кабинет</button>
        ${admin}
        <span class="who">${esc(state.user.username)}</span>
        <button id="nav-logout">Выход</button>`;
      $("#nav-upload").onclick = startUpload;
      $("#nav-me").onclick = () => openProfile(state.user.id, true);
      $("#nav-logout").onclick = () => setAuth(null, null);
      if (state.user.is_admin) $("#nav-admin").onclick = openAdmin;
    } else {
      nav.innerHTML = `<button id="nav-login" class="primary">Войти / Регистрация</button>`;
      $("#nav-login").onclick = openAuth;
    }
  }

  // ---- auth dialog ----------------------------------------------------------
  function openAuth() {
    openModal(`
      <h2>Вход</h2>
      <div class="tabs">
        <button id="tab-login" class="active">Вход</button>
        <button id="tab-register">Регистрация</button>
      </div>
      <label>Логин</label><input id="au-user" autocomplete="username" />
      <label>Пароль</label><input id="au-pass" type="password" autocomplete="current-password" />
      <div class="msg" id="au-msg"></div>
      <button id="au-submit" class="primary">Войти</button>`);
    let mode = "login";
    const setMode = (m) => {
      mode = m;
      $("#tab-login").classList.toggle("active", m === "login");
      $("#tab-register").classList.toggle("active", m === "register");
      $("#au-submit").textContent = m === "login" ? "Войти" : "Создать аккаунт";
    };
    $("#tab-login").onclick = () => setMode("login");
    $("#tab-register").onclick = () => setMode("register");
    $("#au-submit").onclick = async () => {
      const username = $("#au-user").value.trim();
      const password = $("#au-pass").value;
      try {
        const res = await api(`/api/${mode}`, { method: "POST", json: { username, password } });
        setAuth(res.token, res.user);
        closeModal();
      } catch (e) { $("#au-msg").textContent = e.message; }
    };
  }

  // ---- upload flow ----------------------------------------------------------
  function startUpload() {
    if (!state.user) return openAuth();
    // Phase 1: pick a point on the map.
    const bar = document.createElement("div");
    bar.className = "pickbar";
    bar.innerHTML = `Кликните точку на карте &nbsp; <button id="pick-cancel">Отмена</button>`;
    document.body.appendChild(bar);
    document.body.classList.add("picking");
    $("#pick-cancel").onclick = cancelPick;
    function cancelPick() {
      document.body.classList.remove("picking");
      bar.remove(); map.off("click", onPick); state.pick = null;
    }
    function onPick(e) {
      cancelPick();
      openUploadForm(e.latlng.lat, e.latlng.lng);
    }
    state.pick = onPick;
    map.on("click", onPick);
  }

  function openUploadForm(lat, lng) {
    openModal(`
      <h2>Новая загрузка</h2>
      <div class="hint">Точка: ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      <label>Файл (фото или видео)</label>
      <input id="up-file" type="file" accept="image/*,video/*" />
      <label>Название</label><input id="up-title" maxlength="120" />
      <label>Описание</label><textarea id="up-desc" rows="3" maxlength="2000"></textarea>
      <div class="msg" id="up-msg"></div>
      <button id="up-submit" class="primary">Отправить на модерацию</button>`);
    $("#up-submit").onclick = async () => {
      const file = $("#up-file").files[0];
      const title = $("#up-title").value.trim();
      if (!file) return ($("#up-msg").textContent = "Выберите файл");
      if (!title) return ($("#up-msg").textContent = "Введите название");
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title);
      fd.append("description", $("#up-desc").value.trim());
      fd.append("lat", lat); fd.append("lng", lng);
      $("#up-submit").disabled = true;
      $("#up-msg").textContent = "Загрузка…";
      try {
        await api("/api/media", { method: "POST", body: fd });
        openModal(`<h2>Готово ✅</h2><p>Материал отправлен на модерацию.
          После одобрения администратором он появится на карте.</p>
          <button data-close class="primary">Закрыть</button>`);
      } catch (e) {
        $("#up-submit").disabled = false;
        $("#up-msg").textContent = e.message;
      }
    };
  }

  // ---- media detail ---------------------------------------------------------
  async function openMedia(id) {
    let m;
    try { m = await api(`/api/media/${id}`); } catch (e) { return; }
    const media = m.kind === "video"
      ? `<video src="${m.url}" controls style="max-width:100%;border-radius:8px"></video>`
      : `<img src="${m.url}" style="max-width:100%;border-radius:8px" />`;
    openModal(`
      <h2>${esc(m.title)}</h2>
      ${media}
      <p>${esc(m.description) || "<span class='hint'>без описания</span>"}</p>
      <div class="hint">📍 ${m.lat.toFixed(4)}, ${m.lng.toFixed(4)} · автор:
        <a href="#" id="md-author">${esc(m.username)}</a> ·
        <span class="badge ${m.status}">${m.status}</span></div>`);
    $("#md-author").onclick = (e) => { e.preventDefault(); openProfile(m.user_id, false); };
  }

  // ---- profiles / cabinet ---------------------------------------------------
  async function openProfile(userId, self) {
    let data;
    try {
      data = self
        ? { user: state.user, media: await api("/api/me/media") }
        : await api(`/api/users/${userId}`);
    } catch (e) { return openModal(`<h2>Ошибка</h2><p>${esc(e.message)}</p>`); }
    const media = data.media || [];
    const title = self ? "Мой кабинет" : `Профиль: ${esc(data.user.username)}`;
    const cards = media.length
      ? `<div class="grid">${media.map(cardHtml).join("")}</div>`
      : `<p class="hint">${self ? "У вас пока нет загрузок." : "Нет опубликованных материалов."}</p>`;
    openModal(`<h2>${title}</h2>
      ${self ? `<p class="hint">Показаны все ваши загрузки со статусами.</p>` : ""}
      ${cards}`);
    modalBody.querySelectorAll("[data-media]").forEach((el) =>
      (el.onclick = () => openMedia(el.getAttribute("data-media"))));
  }

  const cardHtml = (m) => `
    <div class="card" data-media="${m.id}" style="cursor:pointer">
      ${m.thumb
        ? `<img class="thumb" src="${m.thumb}" loading="lazy" />`
        : m.kind === "video"
          ? `<div class="thumb" style="display:flex;align-items:center;justify-content:center;font-size:32px">🎬</div>`
          : `<img class="thumb" src="${m.url}" loading="lazy" />`}
      <div class="meta">
        <div class="t">${esc(m.title)}</div>
        ${m.status ? `<span class="badge ${m.status}">${m.status}</span>` : ""}
      </div>
    </div>`;

  // ---- admin ----------------------------------------------------------------
  async function openAdmin() {
    let items;
    try { items = await api("/api/admin/pending"); } catch (e) { return; }
    const body = items.length
      ? `<div class="grid">${items.map(cardHtml).join("")}</div>`
      : `<p class="hint">Очередь пуста 🎉</p>`;
    openModal(`<h2>Модерация · ${items.length}</h2>${body}`);
    modalBody.querySelectorAll("[data-media]").forEach((el) =>
      (el.onclick = () => reviewDialog(el.getAttribute("data-media"))));
  }

  async function reviewDialog(id) {
    const m = await api(`/api/media/${id}`);
    const media = m.kind === "video"
      ? `<video src="${m.url}" controls style="max-width:100%;border-radius:8px"></video>`
      : `<img src="${m.url}" style="max-width:100%;border-radius:8px" />`;
    openModal(`<h2>${esc(m.title)}</h2>${media}
      <p>${esc(m.description)}</p>
      <div class="hint">автор: ${esc(m.username)} · 📍 ${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}</div>
      <div class="row" style="margin-top:12px">
        <button id="rv-ok" class="ok">Одобрить</button>
        <button id="rv-no" class="danger">Отклонить</button>
      </div>`);
    const act = async (verb) => {
      await api(`/api/admin/media/${id}/${verb}`, { method: "POST" });
      openAdmin();
      if (verb === "approve") loadPoints();
    };
    $("#rv-ok").onclick = () => act("approve");
    $("#rv-no").onclick = () => act("reject");
  }

  // ---- boot -----------------------------------------------------------------
  renderNav();
  loadPoints();
  // Validate a stored token; drop it if stale.
  if (state.token) api("/api/me").then((u) => setAuth(state.token, u)).catch(() => setAuth(null, null));
})();
