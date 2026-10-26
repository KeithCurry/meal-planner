const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MEALS = ["breakfast", "lunch", "dinner"];

let user = null;
let recipes = [];
let planWeek = mondayOf(new Date());
let groceryWeek = mondayOf(new Date());

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function labelRange(start) {
  const end = addDays(start, 6);
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${f(start)} – ${f(end)}`;
}
function parseQty(str) {
  if (!str) return null;
  str = str.trim();
  const mixed = str.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return +mixed[1] + mixed[2] / mixed[3];
  const frac = str.match(/^(\d+)\/(\d+)$/);
  if (frac) return frac[1] / frac[2];
  const n = parseFloat(str);
  return Number.isNaN(n) ? null : n;
}
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
// Splits "2 1/2 cups flour" into qty 2.5 and rest "cups flour"
function splitIngredient(line) {
  const m = line.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)?\s*(.*)$/);
  return { qty: parseQty(m?.[1]), rest: (m?.[2] || line).trim() };
}
function scaleIngredient(line, factor) {
  const { qty, rest } = splitIngredient(line);
  if (qty === null) return line;
  return `${fmt(qty * factor)} ${rest}`;
}

// ---------- auth & startup ----------
async function init() {
  document.querySelectorAll("nav button[data-tab]").forEach((b) =>
    (b.onclick = () => showTab(b.dataset.tab)));

  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithOtp({
      email: $("login-email").value.trim(),
      options: { emailRedirectTo: location.href.split("#")[0] },
    });
    $("login-msg").textContent = error ? error.message : "Check your email for a sign-in link.";
  };
  $("logout").onclick = () => sb.auth.signOut();

  $("recipe-form").onsubmit = saveRecipe;
  $("search").oninput = renderRecipes;
  $("tag-filter").onchange = renderRecipes;

  $("prev-week").onclick = () => { planWeek = addDays(planWeek, -7); renderPlanner(); };
  $("next-week").onclick = () => { planWeek = addDays(planWeek, 7); renderPlanner(); };
  $("g-prev").onclick = () => { groceryWeek = addDays(groceryWeek, -7); renderGrocery(); };
  $("g-next").onclick = () => { groceryWeek = addDays(groceryWeek, 7); renderGrocery(); };

  const { data } = await sb.auth.getSession();
  setUser(data.session?.user ?? null);
  sb.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
}

function setUser(u) {
  user = u;
  $("login-view").hidden = !!u;
  $("app-view").hidden = !u;
  $("nav").hidden = !u;
  if (u) loadRecipes();
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  document.querySelectorAll("nav button[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  if (name === "planner") renderPlanner();
  if (name === "grocery") renderGrocery();
}

// ---------- recipes ----------
async function loadRecipes() {
  const { data, error } = await sb.from("recipes").select("*").order("title");
  if (error) return alert(error.message);
  recipes = data || [];

  const tags = [...new Set(recipes.flatMap((r) => r.tags))].sort();
  const current = $("tag-filter").value;
  $("tag-filter").innerHTML =
    `<option value="">All tags</option>` + tags.map((t) => `<option>${esc(t)}</option>`).join("");
  $("tag-filter").value = current;

  renderRecipes();
}

function renderRecipes() {
  const q = $("search").value.trim().toLowerCase();
  const tag = $("tag-filter").value;
  const list = recipes.filter((r) => {
    const hay = (r.title + " " + r.ingredients.join(" ")).toLowerCase();
    return (!q || hay.includes(q)) && (!tag || r.tags.includes(tag));
  });

  $("recipe-list").innerHTML = list.length
    ? list.map((r) => `
      <article class="card recipe">
        <h3>${esc(r.title)}</h3>
        <div class="meta">${r.minutes ? r.minutes + " min · " : ""}serves ${r.servings}</div>
        ${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        ${r.description ? `<p>${esc(r.description)}</p>` : ""}
        <details><summary>Ingredients & steps</summary>
          <ul>${r.ingredients.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
          ${esc(r.steps || "")}
        </details>
        <button class="danger" data-del="${r.id}">Delete</button>
      </article>`).join("")
    : `<p class="muted">No recipes yet. Add one above.</p>`;

  document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => deleteRecipe(b.dataset.del)));
}

async function saveRecipe(e) {
  e.preventDefault();
  const split = (s) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const row = {
    user_id: user.id,
    title: $("r-title").value.trim(),
    description: $("r-desc").value.trim() || null,
    minutes: parseInt($("r-minutes").value) || null,
    servings: parseInt($("r-servings").value) || 4,
    tags: split($("r-tags").value),
    ingredients: $("r-ingredients").value.split("\n").map((x) => x.trim()).filter(Boolean),
    steps: $("r-steps").value.trim() || null,
  };
  const { error } = await sb.from("recipes").insert(row);
  if (error) return alert(error.message);
  e.target.reset();
  $("r-servings").value = 4;
  loadRecipes();
}

async function deleteRecipe(id) {
  if (!confirm("Delete this recipe?")) return;
  const { error } = await sb.from("recipes").delete().eq("id", id);
  if (error) return alert(error.message);
  loadRecipes();
}

// ---------- weekly planner ----------
async function renderPlanner() {
  const start = planWeek;
  const end = addDays(start, 6);
  $("week-label").textContent = labelRange(start);

  const { data: plan, error } = await sb.from("meal_plan").select("*")
    .gte("plan_date", iso(start)).lte("plan_date", iso(end));
  if (error) return alert(error.message);

  const lookup = {};
  (plan || []).forEach((p) => (lookup[`${p.plan_date}|${p.meal}`] = p));
  const options = (selected) =>
    `<option value="">—</option>` + recipes.map((r) =>
      `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${esc(r.title)}</option>`).join("");

  let html = `<tr><th></th>` + DAYS.map((d, i) => {
    const date = addDays(start, i);
    return `<th>${d}<br><span class="muted">${date.getDate()}</span></th>`;
  }).join("") + `</tr>`;

  MEALS.forEach((meal) => {
    html += `<tr><th>${meal}</th>` + DAYS.map((_, i) => {
      const date = iso(addDays(start, i));
      const p = lookup[`${date}|${meal}`];
      return `<td>
        <select data-date="${date}" data-meal="${meal}" data-field="recipe">${options(p?.recipe_id)}</select>
        <input type="number" min="1" value="${p?.servings ?? 4}" title="Servings"
          data-date="${date}" data-meal="${meal}" data-field="servings">
      </td>`;
    }).join("") + `</tr>`;
  });

  $("plan-table").innerHTML = html;
  document.querySelectorAll("#plan-table select, #plan-table input").forEach((el) =>
    (el.onchange = () => savePlanSlot(el.dataset.date, el.dataset.meal)));
}

async function savePlanSlot(date, meal) {
  const recipeSel = document.querySelector(`[data-date="${date}"][data-meal="${meal}"][data-field="recipe"]`);
  const servingsIn = document.querySelector(`[data-date="${date}"][data-meal="${meal}"][data-field="servings"]`);
  const recipe_id = recipeSel.value || null;
  const servings = parseInt(servingsIn.value) || 4;

  let error;
  if (!recipe_id) {
    ({ error } = await sb.from("meal_plan").delete()
      .eq("plan_date", date).eq("meal", meal));
  } else {
    ({ error } = await sb.from("meal_plan").upsert(
      { user_id: user.id, plan_date: date, meal, recipe_id, servings },
      { onConflict: "plan_date,meal" }));
  }
  if (error) alert(error.message);
}

// ---------- grocery list ----------
async function renderGrocery() {
  const start = groceryWeek;
  const end = addDays(start, 6);
  $("g-label").textContent = labelRange(start);

  const { data: plan, error } = await sb.from("meal_plan")
    .select("servings, recipes(title, servings, ingredients)")
    .gte("plan_date", iso(start)).lte("plan_date", iso(end));
  if (error) return alert(error.message);

  const key = `grocery-${iso(start)}`;
  const checked = new Set(JSON.parse(localStorage.getItem(key) || "[]"));

  // Build a list of ingredient lines scaled to the planned servings
  const items = [];
  (plan || []).forEach((p) => {
    if (!p.recipes) return;
    const factor = p.servings / (p.recipes.servings || 4);
    p.recipes.ingredients.forEach((line) => {
      const scaled = scaleIngredient(line, factor);
      items.push({ text: scaled, from: p.recipes.title });
    });
  });

  // Combine lines with the same ingredient name and add quantities together
  const combined = new Map();
  items.forEach(({ text }) => {
    const { qty, rest } = splitIngredient(text);
    const k = rest.toLowerCase();
    if (combined.has(k) && qty !== null && combined.get(k).qty !== null) {
      combined.get(k).qty += qty;
    } else if (!combined.has(k)) {
      combined.set(k, { qty, rest, raw: text });
    }
  });

  const lines = [...combined.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => ({
      id: k,
      text: v.qty !== null ? `${fmt(v.qty)} ${v.rest}` : v.raw,
    }));

  $("grocery-list").innerHTML = lines.length
    ? `<div class="card">` + lines.map((l) => `
        <label class="${checked.has(l.id) ? "checked" : ""}">
          <input type="checkbox" data-id="${esc(l.id)}" ${checked.has(l.id) ? "checked" : ""}>
          ${esc(l.text)}
        </label>`).join("") + `</div>`
    : `<p class="muted">Nothing planned for this week yet.</p>`;

  document.querySelectorAll("#grocery-list input[type=checkbox]").forEach((cb) => {
    cb.onchange = () => {
      const set = new Set(JSON.parse(localStorage.getItem(key) || "[]"));
      cb.checked ? set.add(cb.dataset.id) : set.delete(cb.dataset.id);
      localStorage.setItem(key, JSON.stringify([...set]));
      cb.parentElement.classList.toggle("checked", cb.checked);
    };
  });
}

init();
