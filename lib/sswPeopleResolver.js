/**
 * Resolves a participant's display name to an SSW.People.Profiles folder slug.
 *
 * Profile folders live at https://github.com/SSWConsulting/SSW.People.Profiles
 * as `{First-Last}` directories (e.g. `Thomas-Iwainski`). Teams display names
 * sometimes use nicknames (e.g. "Tom Iwainski") that don't slug-match exactly.
 *
 * Resolution rules (in order):
 *   1. Exact match on first AND last name -> use it
 *   2. Last name matches AND only one profile has that last name -> use it
 *   3. Otherwise (multiple last-name matches with no exact first-name hit, or
 *      no last-name match at all) -> null (caller renders initials)
 */

const PEOPLE_PROFILES_API_URL =
  "https://api.github.com/repos/SSWConsulting/SSW.People.Profiles/contents/";

let _cachedSlugs = null;

async function fetchSswProfileSlugs() {
  if (_cachedSlugs) return _cachedSlugs;

  const headers = { "User-Agent": "ssw-tiger" };
  if (process.env.GITHUB_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(PEOPLE_PROFILES_API_URL, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch SSW.People.Profiles contents: ${response.status} ${response.statusText}`,
    );
  }
  const items = await response.json();

  _cachedSlugs = items
    .filter((item) => item.type === "dir" && /-/.test(item.name))
    .map((item) => item.name);

  return _cachedSlugs;
}

function cleanName(name) {
  if (!name) return "";
  return name.replace(/\s*\[[^\]]*\]\s*/g, "").trim();
}

function splitName(name) {
  const cleaned = cleanName(name);
  if (!cleaned) return { firstName: "", lastName: "" };
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function splitSlug(slug) {
  const parts = slug.split("-");
  if (parts.length < 2) return { firstName: parts[0] || "", lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function resolveSswProfileSlug(displayName, slugList) {
  if (!displayName || !Array.isArray(slugList) || slugList.length === 0) {
    return null;
  }

  const { firstName, lastName } = splitName(displayName);
  if (!lastName) return null;

  const lowerFirst = firstName.toLowerCase();
  const lowerLast = lastName.toLowerCase();

  const candidates = slugList.map((slug) => ({ slug, ...splitSlug(slug) }));

  const exact = candidates.find(
    (c) =>
      c.lastName.toLowerCase() === lowerLast &&
      c.firstName.toLowerCase() === lowerFirst,
  );
  if (exact) return exact.slug;

  const lastMatches = candidates.filter(
    (c) => c.lastName.toLowerCase() === lowerLast,
  );
  if (lastMatches.length === 1) return lastMatches[0].slug;

  return null;
}

function _resetCacheForTests() {
  _cachedSlugs = null;
}

module.exports = {
  fetchSswProfileSlugs,
  resolveSswProfileSlug,
  cleanName,
  splitName,
  splitSlug,
  _resetCacheForTests,
};
