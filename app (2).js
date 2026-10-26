const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ---------- state ----------
let user = null;
let currentTab = "recipes";
let recipes = [];
let activePlan = null;   // newest row in meal_plans
let planMeals = [];      // [{ id, recipe_id, recipes }] for activePlan
let groceryRows = [];

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

const FRACTIONS = { "½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8" };
function normalizeFractions(s) {
  return s.replace(/(\d)([½¼¾⅓⅔⅛])/g, "$1 $2").replace(/[½¼¾⅓⅔⅛]/g, (c) => FRACTIONS[c]);
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
function splitIngredient(line) {
  const m = line.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)?\s*(.*)$/);
  return { qty: parseQty(m?.[1]), rest: (m?.[2] || line).trim() };
}
// Combines the same ingredient across recipes and adds quantities together
function combineIngredients(recipeList) {
  const map = new Map();
  recipeList.forEach((r) =>
    (r.ingredients || []).forEach((raw) => {
      const line = normalizeFractions(raw);
      const { qty, rest } = splitIngredient(line);
      const key = rest.toLowerCase();
      if (!map.has(key)) map.set(key, { qty, rest, raw: line });
      else if (qty !== null && map.get(key).qty !== null) map.get(key).qty += qty;
    }));
  return [...map.values()]
    .map((v) => (v.qty !== null ? `${fmt(v.qty)} ${v.rest}` : v.raw))
    .sort((a, b) => a.localeCompare(b));
}

// ---------- auth & startup ----------
async function init() {
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithOtp({
      email: $("login-email").value.trim(),
      options: { emailRedirectTo: location.href.split("#")[0] },
    });
    $("login-msg").textContent = error ? error.message : "Check your email for a sign-in link.";
  };
  $("logout").onclick = () => sb.auth.signOut();
  document.querySelectorAll("nav button[data-tab]").forEach((b) =>
    (b.onclick = () => showTab(b.dataset.tab)));

  $("recipe-form").onsubmit = saveRecipe;
  $("r-pdf").onchange = (e) => e.target.files[0] && importPdf(e.target.files[0]);
  $("grocery-form").onsubmit = addManualItem;
  $("search").oninput = renderRecipes;
  $("tag-filter").onchange = renderRecipes;
  $("dialog-close").onclick = () => $("recipe-dialog").close();

  const { data } = await sb.auth.getSession();
  setUser(data.session?.user ?? null);
  sb.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
}

function setUser(u) {
  user = u;
  $("login-view").hidden = !!u;
  $("app-view").hidden = !u;
  $("nav").hidden = !u;
  if (u) {
    showTab(currentTab);
    loadAll();
  }
}

function showTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
  document.querySelectorAll("nav button[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
}

function renderAll() {
  renderRecipes();
  renderPlanner();
  renderGrocery();
}

// ---------- loading ----------
async function loadAll() {
  await Promise.all([loadRecipes(), loadPlan(), loadGrocery()]);
  renderAll();
}

async function loadRecipes() {
  const { data, error } = await sb.from("recipes").select("*").order("title");
  if (error) return toast(error.message);
  recipes = data || [];
}

async function loadPlan() {
  const { data, error } = await sb.from("meal_plans")
    .select("*").order("created_at", { ascending: false }).limit(1);
  if (error) return toast(error.message);
  activePlan = data?.[0] ?? null;
  planMeals = [];
  if (activePlan) {
    const { data: rows, error: err2 } = await sb.from("plan_meals")
      .select("id, recipe_id, recipes(*)")
      .eq("plan_id", activePlan.id)
      .order("position");
    if (err2) return toast(err2.message);
    planMeals = (rows || []).filter((m) => m.recipes);
  }
}

async function loadGrocery() {
  const { data, error } = await sb.from("grocery_items").select("*").order("created_at");
  if (error) return toast(error.message);
  groceryRows = data || [];
}

// ---------- recipes ----------
function renderRecipes() {
  const tagSel = $("tag-filter");
  const tags = [...new Set(recipes.flatMap((r) => r.tags))].sort();
  const current = tagSel.value;
  tagSel.innerHTML = `<option value="">All tags</option>` +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  tagSel.value = current;

  const q = $("search").value.trim().toLowerCase();
  const tag = tagSel.value;
  const list = recipes.filter((r) => {
    const hay = (r.title + " " + r.ingredients.join(" ")).toLowerCase();
    return (!q || hay.includes(q)) && (!tag || r.tags.includes(tag));
  });

  const canAdd = activePlan && !activePlan.confirmed_at;
  $("recipe-list").innerHTML = list.length
    ? list.map((r) => {
        const inPlan = planMeals.some((m) => m.recipe_id === r.id);
        let planAction = "";
        if (canAdd) {
          planAction = inPlan
            ? `<span class="pill">In this week's plan</span>`
            : `<button class="primary" data-action="add-meal" data-id="${r.id}">Add to plan</button>`;
        }
        return `
        <article class="card recipe">
          <h3>${esc(r.title)}</h3>
          <div class="meta">${r.minutes ? r.minutes + " min · " : ""}serves ${r.servings}</div>
          <div>${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
          ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ""}
          <div class="actions">
            <button data-action="open" data-id="${r.id}">View steps</button>
            ${planAction}
            <button class="ghost danger" data-action="delete-recipe" data-id="${r.id}">Delete</button>
          </div>
        </article>`;
      }).join("")
    : `<p class="muted empty">No recipes match. Try a different search, or add one under "+ Add recipe".</p>`;
}

function openRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  $("d-title").textContent = r.title;
  $("d-meta").textContent = [r.minutes ? `${r.minutes} min` : null, `serves ${r.servings}`]
    .filter(Boolean).join(" · ");
  $("d-steps").textContent = r.steps || "No steps saved for this recipe.";
  $("recipe-dialog").showModal();
}

async function saveRecipe(e) {
  e.preventDefault();
  const split = (s) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const row = {
    title: $("r-title").value.trim(),
    description: $("r-desc").value.trim() || null,
    minutes: parseInt($("r-minutes").value) || null,
    servings: parseInt($("r-servings").value) || 4,
    tags: split($("r-tags").value),
    ingredients: $("r-ingredients").value.split("\n").map((x) => x.trim()).filter(Boolean),
    steps: $("r-steps").value.trim() || null,
  };
  const { error } = await sb.from("recipes").insert(row);
  if (error) return toast(error.message);
  e.target.reset();
  $("r-servings").value = 4;
  $("pdf-status").textContent = "";
  await loadAll();
  showTab("recipes");
  toast("Recipe saved");
}

async function deleteRecipe(id) {
  if (!confirm("Delete this recipe? It will also be removed from any plans it's in.")) return;
  const { error } = await sb.from("recipes").delete().eq("id", id);
  if (error) return toast(error.message);
  await loadAll();
  toast("Recipe deleted");
}

// ---------- PDF import (text is read in the browser; the PDF itself is not stored) ----------
async function readPdfLines(file) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map();
    content.items.forEach((item) => {
      if (!item.str.trim()) return;
      const y = Math.round(item.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], s: item.str });
    });
    [...rows.keys()].sort((a, b) => b - a).forEach((y) => {
      const text = rows.get(y).sort((a, b) => a.x - b.x).map((t) => t.s)
        .join(" ").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    });
  }
  return lines;
}

function parseRecipeLines(lines) {
  const metaIdx = lines.findIndex((l) => /\d+\s*minutes?\s*\|\s*\d+\s*servings?/i.test(l));
  const meta = metaIdx >= 0
    ? lines[metaIdx].match(/(\d+)\s*minutes?\s*\|\s*(\d+)\s*servings?/i)
    : null;
  const titleLines = metaIdx > 0 ? lines.slice(0, metaIdx) : lines.slice(0, 1);
  const title = titleLines.join(" ").replace(/\s+/g, " ").trim();

  const ingStart = lines.findIndex((l) => /^Ingredients$/i.test(l));
  const cookStart = lines.findIndex((l) => /^Cookware$/i.test(l));
  const instStart = lines.findIndex((l) => /^Instructions$/i.test(l));
  const ingEnd = cookStart > ingStart ? cookStart : instStart;
  const ingredients = ingStart >= 0 && ingEnd > ingStart
    ? lines.slice(ingStart + 1, ingEnd).map(normalizeFractions)
    : [];

  // Numbered step lines ("3 Melt butter...") start a step; lines starting lowercase continue the last one
  const steps = [];
  if (instStart >= 0) {
    lines.slice(instStart + 1).forEach((l) => {
      if (/^\d{1,2} [A-Z]/.test(l)) steps.push(l.replace(/^\d{1,2} /, ""));
      else if (/^[a-z(]/.test(l) && steps.length) steps[steps.length - 1] += " " + l;
    });
  }

  return {
    title,
    minutes: meta ? +meta[1] : null,
    servings: meta ? +meta[2] : null,
    ingredients,
    steps,
  };
}

async function importPdf(file) {
  $("pdf-status").textContent = "Reading PDF...";
  try {
    const parsed = parseRecipeLines(await readPdfLines(file));
    $("r-title").value = parsed.title;
    $("r-minutes").value = parsed.minutes ?? "";
    $("r-servings").value = parsed.servings ?? 4;
    $("r-ingredients").value = parsed.ingredients.join("\n");
    $("r-steps").value = parsed.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    $("pdf-status").textContent =
      `Filled in from ${file.name}. Check it over, add tags, then save. The PDF itself is not stored.`;
  } catch (err) {
    $("pdf-status").textContent = "Couldn't read that PDF: " + err.message;
  }
}

// ---------- weekly plan ----------
function renderPlanner() {
  const el = $("planner");
  if (!activePlan) {
    el.innerHTML = `
      <div class="card empty">
        <h2>No plan yet</h2>
        <p class="muted">Start a plan, add this week's dinners, then confirm it to build your grocery list.</p>
        <button class="primary" data-action="new-plan">Start this week's plan</button>
      </div>`;
    return;
  }

  const confirmed = !!activePlan.confirmed_at;
  const list = planMeals.length
    ? `<ul class="meal-list">${planMeals.map((m) => `
        <li>
          <button class="link" data-action="open" data-id="${m.recipes.id}">${esc(m.recipes.title)}</button>
          ${confirmed ? "" : `<button class="ghost danger" data-action="remove-meal" data-id="${m.id}">Remove</button>`}
        </li>`).join("")}</ul>`
    : `<p class="muted">No dinners added yet.</p>`;

  const options = recipes
    .filter((r) => !planMeals.some((m) => m.recipe_id === r.id))
    .map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join("");

  const picker = confirmed ? "" : `
    <div class="picker">
      <select id="plan-pick"><option value="">Choose a dinner...</option>${options}</select>
      <button class="primary" data-action="add-meal-from-picker">Add</button>
    </div>
    <button class="primary big" data-action="confirm-plan" ${planMeals.length ? "" : "disabled"}>
      I'm done building this week's plan
    </button>`;

  el.innerHTML = `
    <div class="card">
      <h2>${confirmed ? "Meals this week" : "Building this week's plan"}</h2>
      ${confirmed
        ? `<p class="muted">Confirmed ${new Date(activePlan.confirmed_at).toLocaleDateString()}. To change it, start a new plan.</p>`
        : ""}
      ${list}
      ${picker}
      ${confirmed ? `<button class="primary" data-action="new-plan">Start a new plan</button>` : ""}
    </div>`;
}

async function addMeal(recipeId) {
  if (!activePlan || activePlan.confirmed_at) return;
  const { error } = await sb.from("plan_meals").insert({
    plan_id: activePlan.id,
    recipe_id: recipeId,
    position: planMeals.length,
  });
  if (error) return toast(error.message);
  await loadPlan();
  renderAll();
  toast("Added to this week's plan");
}

async function removeMeal(id) {
  const { error } = await sb.from("plan_meals").delete().eq("id", id);
  if (error) return toast(error.message);
  await loadPlan();
  renderAll();
}

async function newPlan() {
  const { error } = await sb.from("meal_plans").insert({});
  if (error) return toast(error.message);
  await Promise.all([loadPlan(), loadGrocery()]);
  renderAll();
  toast("New plan started");
}

async function confirmPlan() {
  if (!activePlan || !planMeals.length) return;
  const ok = confirm(
    "Confirm this week's plan? The ingredients will be added to the grocery list. " +
    "The plan can't be changed afterward. To change it, start a new plan."
  );
  if (!ok) return;

  const items = combineIngredients(planMeals.map((m) => m.recipes));
  if (items.length) {
    const rows = items.map((name) => ({ plan_id: activePlan.id, name }));
    const { error } = await sb.from("grocery_items").insert(rows);
    if (error) return toast(error.message);
  }
  const { error } = await sb.from("meal_plans")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("id", activePlan.id);
  if (error) return toast(error.message);

  await Promise.all([loadPlan(), loadGrocery()]);
  renderAll();
  toast("Plan confirmed. Grocery list updated.");
}

// ---------- grocery list ----------
function visibleGrocery() {
  return groceryRows.filter((g) => g.plan_id === null || (activePlan && g.plan_id === activePlan.id));
}

function renderGrocery() {
  const items = visibleGrocery();
  const fromPlan = items.filter((g) => g.plan_id);
  const manual = items.filter((g) => !g.plan_id);
  const row = (g) => `
    <label class="item">
      <input type="checkbox" data-action="check-item" data-id="${g.id}">
      <span>${esc(g.name)}</span>
    </label>`;

  let html = "";
  if (activePlan && !activePlan.confirmed_at) {
    html += `<p class="muted">Confirm this week's plan to add its ingredients here.</p>`;
  }
  if (fromPlan.length) {
    html += `<div class="card"><p class="group-title">From this week's dinners</p>${fromPlan.map(row).join("")}</div>`;
  }
  if (manual.length) {
    html += `<div class="card"><p class="group-title">Other items</p>${manual.map(row).join("")}</div>`;
  }
  if (!items.length) {
    html += `<p class="muted empty">Nothing on the list yet.</p>`;
  }
  $("grocery-list").innerHTML = html;
}

async function addManualItem(e) {
  e.preventDefault();
  const name = $("g-new").value.trim();
  if (!name) return;
  const { error } = await sb.from("grocery_items").insert({ name });
  if (error) return toast(error.message);
  $("g-new").value = "";
  await loadGrocery();
  renderGrocery();
}

// Checking an item clears it from the list
async function checkItem(id) {
  const { error } = await sb.from("grocery_items").delete().eq("id", id);
  if (error) return toast(error.message);
  await loadGrocery();
  renderGrocery();
}

// ---------- event delegation ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case "open": return openRecipe(id);
    case "add-meal": return addMeal(id);
    case "add-meal-from-picker": {
      const pick = $("plan-pick")?.value;
      if (pick) addMeal(pick);
      else toast("Choose a dinner first");
      return;
    }
    case "remove-meal": return removeMeal(id);
    case "new-plan": return newPlan();
    case "confirm-plan": return confirmPlan();
    case "delete-recipe": return deleteRecipe(id);
  }
});

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-action='check-item']");
  if (el && el.checked) checkItem(el.dataset.id);
});

init();
