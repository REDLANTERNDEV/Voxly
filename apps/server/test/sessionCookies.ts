import assert from "node:assert/strict";

type CookieResponse = { cookies: Array<{ name: string; value: string }> };

/** Apply Set-Cookie in delivery order, including deletion, like a browser. */
export function applyCookies(jar: Record<string, string>, response: CookieResponse) {
  for (const cookie of response.cookies) {
    if (cookie.value) jar[cookie.name] = cookie.value;
    else delete jar[cookie.name];
  }
  return jar;
}

export function cookieJar(response: CookieResponse) {
  return applyCookies({}, response);
}

/** Fixture jars contain one newly issued token; never assume its cookie name. */
export function sessionToken(jar: Record<string, string>) {
  const entries = Object.entries(jar).filter(([name]) => /^(?:__Host-)?voxly_session(?:_[a-f0-9]{64})?$/.test(name));
  assert.equal(entries.length, 1, "expected one session credential in this fixture");
  return entries[0]![1];
}
