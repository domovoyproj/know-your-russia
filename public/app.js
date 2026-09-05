/* KYR frontend — premium interactive map with administrative areas,
   hover counts, gallery view, and cluster points. No Ukrainian flag in attribution. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => root.querySelectorAll(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Russian names for 83 ADM1 regions
  const RU_REGIONS = {
    "RU-ALT": "Алтайский край", "RU-MO": "Республика Мордовия", "RU-TUL": "Тульская область",
    "RU-KGN": "Курганская область", "RU-IN": "Республика Ингушетия",
    "RU-KHM": "Ханты-Мансийский АО — Югра", "RU-KIR": "Кировская область",
    "RU-KO": "Республика Коми", "RU-KOS": "Костромская область", "RU-KYA": "Красноярский край",
    "RU-ZAB": "Забайкальский край", "RU-SVE": "Свердловская область",
    "RU-VGG": "Волгоградская область", "RU-IRK": "Иркутская область", "RU-PER": "Пермский край",
    "RU-PSK": "Псковская область", "RU-ROS": "Ростовская область", "RU-RYA": "Рязанская область",
    "RU-AD": "Республика Адыгея", "RU-SAM": "Самарская область", "RU-KK": "Республика Хакасия",
    "RU-TAM": "Тамбовская область", "RU-TA": "Республика Татарстан", "RU-TOM": "Томская область",
    "RU-NIZ": "Нижегородская область", "RU-KR": "Республика Карелия",
    "RU-ARK": "Архангельская область", "RU-AST": "Астраханская область",
    "RU-BEL": "Белгородская область", "RU-BRY": "Брянская область", "RU-BU": "Республика Бурятия",
    "RU-CE": "Чеченская Республика", "RU-CHE": "Челябинская область",
    "RU-CU": "Чувашская Республика", "RU-TYU": "Тюменская область",
    "RU-SE": "Северная Осетия — Алания", "RU-PNZ": "Пензенская область",
    "RU-AMU": "Амурская область", "RU-KB": "Кабардино-Балкария", "RU-KDA": "Краснодарский край",
    "RU-KRS": "Курская область", "RU-LEN": "Ленинградская область", "RU-ME": "Республика Марий Эл",
    "RU-MOW": "город Москва", "RU-MOS": "Московская область", "RU-MUR": "Мурманская область",
    "RU-NEN": "Ненецкий АО", "RU-NGR": "Новгородская область", "RU-NVS": "Новосибирская область",
    "RU-OMS": "Омская область", "RU-ORL": "Орловская область", "RU-SPE": "город Санкт-Петербург",
    "RU-SAK": "Сахалинская область", "RU-SA": "Республика Саха (Якутия)",
    "RU-SAR": "Саратовская область", "RU-SMO": "Смоленская область",
    "RU-STA": "Ставропольский край", "RU-TY": "Республика Тыва", "RU-TVE": "Тверская область",
    "RU-UD": "Удмуртская Республика", "RU-KLU": "Калужская область", "RU-LIP": "Липецкая область",
    "RU-MAG": "Магаданская область", "RU-ULY": "Ульяновская область",
    "RU-VLA": "Владимирская область", "RU-VLG": "Вологодская область",
    "RU-YAR": "Ярославская область", "RU-VOR": "Воронежская область",
    "RU-YAN": "Ямало-Ненецкий АО", "RU-AL": "Республика Алтай", "RU-IVA": "Ивановская область",
    "RU-YEV": "Еврейская автономная область", "RU-KL": "Республика Калмыкия",
    "RU-KAM": "Камчатский край", "RU-KC": "Карачаево-Черкесия",
    "RU-KEM": "Кемеровская область — Кузбасс", "RU-KHA": "Хабаровский край",
    "RU-CHU": "Чукотский АО", "RU-DA": "Республика Дагестан",
    "RU-KGD": "Калининградская область", "RU-ORE": "Оренбургская область",
    "RU-PRI": "Приморский край", "RU-BA": "Республика Башкортостан"
  };

  const getAreaTitle = (p) => {
    if (p.iso && RU_REGIONS[p.iso]) return RU_REGIONS[p.iso];
    return p.name || "Территория";
  };

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

  const state = {
    token: localStorage.getItem("kyr_token") || null,
    user: JSON.parse(localStorage.getItem("kyr_user") || "null"),
    pick: null,
    mode: "1", // "1" = regions, "2" = districts/cities, "points" = individual pins
    activeArea: null,
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

  // ---- MAP INITIALIZATION (NO UKRAINE FLAG!) --------------------------------
  // attributionControl: false -> we create our own clean attribution with NO flag.
  const map = L.map("map", {
    minZoom: 2,
    worldCopyJump: true,
    attributionControl: false,
  }).setView([62, 94], 3);

  // Clean custom attribution control without any flags
  L.control.attribution({
    prefix: '<a href="https://leafletjs.com" target="_blank">Leaflet</a>',
    position: "bottomright",
  }).addTo(map);

  // CartoDB Voyager — high-end, clean cartography
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  const cluster = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
  });
  map.addLayer(cluster);

  let areasLayer = L.geoJSON(null).addTo(map);

  // Floating hover card refs
  const areaCard = $("#area-card");
  const acType = $("#ac-type");
  const acName = $("#ac-name");
  const acTotal = $("#ac-total");
  const acPhotos = $("#ac-photos");
  const acVideos = $("#ac-videos");
  const acBtn = $("#ac-gallery-btn");

  let cardHideTimeout = null;
  const showAreaCard = (props) => {
    clearTimeout(cardHideTimeout);
    state.activeArea = props;
    const title = getAreaTitle(props);
    const typeLabel = props.level === 2 ? "Район / Город" : "Регион РФ";
    acType.textContent = typeLabel;
    acName.textContent = title;
    const total = props.total || 0;
    acTotal.textContent = `${total} ${declension(total, ["материал", "материала", "материалов"])}`;
    acPhotos.textContent = props.photos || 0;
    acVideos.textContent = props.videos || 0;
    areaCard.classList.remove("hidden");
  };

  const hideAreaCard = () => {
    cardHideTimeout = setTimeout(() => {
      areaCard.classList.add("hidden");
      state.activeArea = null;
    }, 200);
  };

  areaCard.addEventListener("mouseenter", () => clearTimeout(cardHideTimeout));
  areaCard.addEventListener("mouseleave", hideAreaCard);

  acBtn.onclick = () => {
    if (state.activeArea) {
      openAreaGallery(state.activeArea.level, state.activeArea.id, getAreaTitle(state.activeArea));
    }
  };

  function declension(n, forms) {
    n = Math.abs(n) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 > 1 && n1 < 5) return forms[1];
    if (n1 === 1) return forms[0];
    return forms[2];
  }

  // ---- POLYGON STYLES -------------------------------------------------------
  function styleArea(feature) {
    const total = feature.properties.total || 0;
    let fillColor = "#1e293b";
    let fillOpacity = 0.08;
    let strokeColor = "rgba(148, 163, 184, 0.4)";
    let weight = 1;

    if (total > 0 && total <= 3) {
      fillColor = "#0284c7";
      fillOpacity = 0.22;
      strokeColor = "#38bdf8";
      weight = 1.2;
    } else if (total > 3 && total <= 15) {
      fillColor = "#d97706";
      fillOpacity = 0.28;
      strokeColor = "#f59e0b";
      weight = 1.4;
    } else if (total > 15) {
      fillColor = "#e11d48";
      fillOpacity = 0.35;
      strokeColor = "#fb7185";
      weight = 1.6;
    }

    return {
      fillColor,
      fillOpacity,
      color: strokeColor,
      weight,
      opacity: 0.9,
    };
  }

  const highlightStyle = {
    weight: 2.5,
    color: "#38bdf8",
    fillColor: "#0284c7",
    fillOpacity: 0.4,
  };

  function onEachArea(feature, layer) {
    const p = feature.properties;
    layer.on({
      mouseover: (e) => {
        layer.setStyle(highlightStyle);
        layer.bringToFront();
        showAreaCard(p);
      },
      mouseout: (e) => {
        areasLayer.resetStyle(layer);
        hideAreaCard();
      },
      click: (e) => {
        L.DomEvent.stopPropagation(e);
        openAreaGallery(p.level, p.id, getAreaTitle(p));
      },
    });
  }

  // ---- DATA REFRESH ---------------------------------------------------------
  let reloadTimer = null;
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadView, 200);
  };
  map.on("moveend zoomend", scheduleReload);

  async function reloadView() {
    if (state.pick) return;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");

    if (state.mode === "points") {
      areasLayer.clearLayers();
      let points = [];
      try { points = await api(`/api/points?bbox=${bbox}`); } catch (e) { return; }
      cluster.clearLayers();
      const markers = points.map((p) => {
        const m = L.marker([p.lat, p.lng]);
        m.on("click", () => openMedia(p.id));
        return m;
      });
      cluster.addLayers(markers);
      $("#hint").textContent = `Меток: ${points.length}`;
      return;
    }

    // Area mode (1 or 2)
    cluster.clearLayers();
    const level = state.mode;
    let data;
    try {
      data = await api(`/api/areas?level=${level}&bbox=${bbox}`);
    } catch (e) {
      console.warn("areas load error:", e);
      return;
    }

    areasLayer.clearLayers();
    if (data && data.features) {
      areasLayer.addData(data);
      areasLayer.setStyle(styleArea);
      areasLayer.eachLayer((layer) => onEachArea(layer.feature, layer));
      const count = data.features.length;
      const label = level === "1" ? "областей" : "районов";
      $("#hint").textContent = `В видимой зоне: ${count} ${label}`;
    }
  }

  // ---- VIEW SWITCHER --------------------------------------------------------
  $$(".switch-btn").forEach((btn) => {
    btn.onclick = () => {
      $$(".switch-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.getAttribute("data-lvl");
      hideAreaCard();
      reloadView();
    };
  });

  // ---- AREA GALLERY MODAL ---------------------------------------------------
  async function openAreaGallery(level, id, title) {
    openModal(`
      <div class="ac-header">
        <span class="ac-badge">${level === 2 ? "Район / Город" : "Регион"}</span>
      </div>
      <h2>${esc(title)}</h2>
      <p class="hint">Загрузка материалов…</p>
    `);
    try {
      const data = await api(`/api/areas/${level}/${id}/media`);
      const items = data.media || [];
      if (!items.length) {
        openModal(`
          <div class="ac-header"><span class="ac-badge">${level === 2 ? "Район / Город" : "Регион"}</span></div>
          <h2>${esc(title)}</h2>
          <p class="hint" style="margin: 20px 0;">В этой зоне пока нет подтверждённых фотографий или видео.</p>
          <button id="ag-upload" class="primary">+ Добавить фото или видео сюда</button>
        `);
        $("#ag-upload").onclick = () => { closeModal(); startUpload(); };
        return;
      }

      openModal(`
        <div class="ac-header">
          <span class="ac-badge">${level === 2 ? "Район / Город" : "Регион"}</span>
          <span class="ac-count">${items.length} ${declension(items.length, ["материал", "материала", "материалов"])}</span>
        </div>
        <h2>${esc(title)}</h2>
        <div class="grid">${items.map(cardHtml).join("")}</div>
      `);
      modalBody.querySelectorAll("[data-media]").forEach((el) =>
        (el.onclick = () => openMedia(el.getAttribute("data-media"))));
    } catch (e) {
      openModal(`<h2>Ошибка</h2><p>${esc(e.message)}</p>`);
    }
  }

  // ---- MODAL ----------------------------------------------------------------
  const modal = $("#modal");
  const modalBody = $("#modal-body");
  const openModal = (html) => { modalBody.innerHTML = html; modal.classList.remove("hidden"); };
  const closeModal = () => { modal.classList.add("hidden"); modalBody.innerHTML = ""; };
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.hasAttribute("data-close")) closeModal();
  });

  // ---- NAV ------------------------------------------------------------------
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

  // ---- AUTH DIALOG ----------------------------------------------------------
  function openAuth() {
    openModal(`
      <h2>Вход в KYR</h2>
      <div class="tabs">
        <button id="tab-login" class="active">Вход</button>
        <button id="tab-register">Регистрация</button>
      </div>
      <label>Логин</label><input id="au-user" autocomplete="username" />
      <label>Пароль</label><input id="au-pass" type="password" autocomplete="current-password" />
      <div class="msg" id="au-msg"></div>
      <button id="au-submit" class="primary" style="width:100%;">Войти</button>`);
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

  // ---- UPLOAD FLOW ----------------------------------------------------------
  function startUpload() {
    if (!state.user) return openAuth();
    hideAreaCard();
    const bar = document.createElement("div");
    bar.className = "pickbar";
    bar.innerHTML = `📍 Кликните точное место на карте &nbsp; <button id="pick-cancel" class="danger">Отмена</button>`;
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
      <h2>Новый материал</h2>
      <div class="hint" style="margin-bottom:12px;">Координаты: ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      <label>Файл (фото или видео)</label>
      <input id="up-file" type="file" accept="image/*,video/*" />
      <label>Название</label><input id="up-title" maxlength="120" placeholder="Например: Озеро Байкал на закате" />
      <label>Описание</label><textarea id="up-desc" rows="3" maxlength="2000" placeholder="Расскажите историю места..."></textarea>
      <div class="msg" id="up-msg"></div>
      <button id="up-submit" class="primary" style="width:100%;">Отправить на модерацию</button>`);
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
        openModal(`<h2>Успешно отправлено ✅</h2><p>Материал отправлен на премодерацию.
          Как только администратор подтвердит его, он появится в этой зоне и на карте.</p>
          <button data-close class="primary">Понятно</button>`);
      } catch (e) {
        $("#up-submit").disabled = false;
        $("#up-msg").textContent = e.message;
      }
    };
  }

  // ---- MEDIA DETAIL ---------------------------------------------------------
  async function openMedia(id) {
    let m;
    try { m = await api(`/api/media/${id}`); } catch (e) { return; }
    const media = m.kind === "video"
      ? `<video src="${m.url}" controls autoplay style="max-width:100%;border-radius:12px;display:block;"></video>`
      : `<img src="${m.url}" style="max-width:100%;border-radius:12px;display:block;" />`;
    openModal(`
      <h2>${esc(m.title)}</h2>
      ${media}
      <p style="margin: 12px 0 6px; font-size: 14px; line-height: 1.5;">${esc(m.description) || "<span class='hint'>Без описания</span>"}</p>
      <div class="hint" style="margin-top:10px;">📍 ${m.lat.toFixed(4)}, ${m.lng.toFixed(4)} · Автор:
        <a href="#" id="md-author" style="color:#38bdf8;font-weight:600;">${esc(m.username)}</a> ·
        <span class="badge ${m.status}">${m.status}</span></div>`);
    $("#md-author").onclick = (e) => { e.preventDefault(); openProfile(m.user_id, false); };
  }

  // ---- PROFILES -------------------------------------------------------------
  async function openProfile(userId, self) {
    let data;
    try {
      data = self
        ? { user: state.user, media: await api("/api/me/media") }
        : await api(`/api/users/${userId}`);
    } catch (e) { return openModal(`<h2>Ошибка</h2><p>${esc(e.message)}</p>`); }
    const media = data.media || [];
    const title = self ? "Личный кабинет" : `Профиль: ${esc(data.user.username)}`;
    const cards = media.length
      ? `<div class="grid">${media.map(cardHtml).join("")}</div>`
      : `<p class="hint">${self ? "У вас пока нет загрузок." : "Нет опубликованных материалов."}</p>`;
    openModal(`<h2>${title}</h2>
      ${self ? `<p class="hint">Здесь отображаются все ваши материалы и их статусы модерации.</p>` : ""}
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

  // ---- ADMIN ----------------------------------------------------------------
  async function openAdmin() {
    let items;
    try { items = await api("/api/admin/pending"); } catch (e) { return; }
    const body = items.length
      ? `<div class="grid">${items.map(cardHtml).join("")}</div>`
      : `<p class="hint">Очередь модерации пуста 🎉</p>`;
    openModal(`<h2>Панель модерации · На проверке: ${items.length}</h2>${body}`);
    modalBody.querySelectorAll("[data-media]").forEach((el) =>
      (el.onclick = () => reviewDialog(el.getAttribute("data-media"))));
  }

  async function reviewDialog(id) {
    const m = await api(`/api/media/${id}`);
    const media = m.kind === "video"
      ? `<video src="${m.url}" controls style="max-width:100%;border-radius:12px"></video>`
      : `<img src="${m.url}" style="max-width:100%;border-radius:12px" />`;
    openModal(`<h2>${esc(m.title)}</h2>${media}
      <p style="margin: 10px 0;">${esc(m.description)}</p>
      <div class="hint">Автор: ${esc(m.username)} · 📍 ${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}</div>
      <div class="row" style="margin-top:16px">
        <button id="rv-ok" class="ok" style="flex:1;padding:10px;">Одобрить</button>
        <button id="rv-no" class="danger" style="flex:1;padding:10px;">Отклонить</button>
      </div>`);
    const act = async (verb) => {
      await api(`/api/admin/media/${id}/${verb}`, { method: "POST" });
      openAdmin();
      if (verb === "approve") reloadView();
    };
    $("#rv-ok").onclick = () => act("approve");
    $("#rv-no").onclick = () => act("reject");
  }

  // ---- BOOT -----------------------------------------------------------------
  renderNav();
  reloadView();
  if (state.token) api("/api/me").then((u) => setAuth(state.token, u)).catch(() => setAuth(null, null));
})();
