import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAdmin, isAdmin, isSameOrigin } from "../auth.js";
import { mockEnv, req, PB_PW, INV_PW } from "./helpers.mjs";

test("each app accepts only its own password", async () => {
  const env = mockEnv();
  assert.equal(await isAdmin(req("/", { password: PB_PW }), env, "pickleball"), true);
  assert.equal(await isAdmin(req("/", { password: INV_PW }), env, "pickleball"), false);
  assert.equal(await isAdmin(req("/", { password: INV_PW }), env, "inventory"), true);
  assert.equal(await isAdmin(req("/", { password: PB_PW }), env, "inventory"), false);
  assert.equal(await isAdmin(req("/"), env, "pickleball"), false);
});

test("unknown app names never authorize (including prototype keys)", async () => {
  const env = mockEnv();
  for (const app of ["__proto__", "constructor", "toString", "", undefined]) {
    assert.equal(await isAdmin(req("/", { password: PB_PW }), env, app), false);
    assert.equal((await requireAdmin(req("/", { password: PB_PW }), env, app)).status, 503);
  }
});

test("missing secret fails closed", async () => {
  const env = mockEnv({ PICKLEBALL_PASSWORD: undefined });
  const r = await requireAdmin(req("/", { password: "" }), env, "pickleball");
  assert.equal(r.status, 503);
  assert.equal(await isAdmin(req("/", { password: "anything" }), env, "pickleball"), false);
});

test("wrong or empty password is 401, right password passes", async () => {
  const env = mockEnv();
  assert.equal((await requireAdmin(req("/", { password: "nope" }), env, "pickleball")).status, 401);
  assert.equal((await requireAdmin(req("/"), env, "pickleball")).status, 401);
  assert.equal(await requireAdmin(req("/", { password: PB_PW }), env, "pickleball"), null);
});

test("same-origin check", () => {
  assert.equal(isSameOrigin(req("/", { origin: "https://kevinrhys.com" })), true);
  assert.equal(isSameOrigin(req("/", { origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(req("/")), true);
});
