// GHSA-6pq8-jhm2-2vcw: official maintainer PoCs and fallback semantics.
// https://github.com/ljharb/qs/security/advisories/GHSA-6pq8-jhm2-2vcw
// https://github.com/ljharb/qs/commit/a952e7519338ef0cfb25694a2988848f93333727
import { expect, test } from "vitest";
import { createRequire } from "node:module";
import { once } from "node:events";
import { constants } from "node:http2";

const workspace = createRequire(new URL("../../packages/mcp-server/package.json", import.meta.url));
const sdk = createRequire(workspace.resolve("@modelcontextprotocol/sdk/server/stdio.js"));
const express = sdk("express");
const expressDependencies = createRequire(sdk.resolve("express"));
const bodyParserDependencies = createRequire(expressDependencies.resolve("body-parser"));
const parents = [
  ["SDK → Express", expressDependencies("qs")],
  ["SDK → Express → body-parser", bodyParserDependencies("qs")],
];

function assertHostileRoundTrip(qs, encodeValuesOnly) {
  const inputs = [
    JSON.parse('{"a":[{"toString":"x"}]}'),
    qs.parse("a[0][toString]=x", { allowPrototypes: true }),
    qs.parse("a[][b]=c", { plainObjects: true }),
  ];
  for (const input of inputs) {
    const output = qs.stringify(input, { arrayFormat: "comma", encodeValuesOnly });
    expect(qs.parse(output)).toEqual({ a: "[object Object]" });
  }
}

for (const [parent, qs] of parents) {
  for (const encodeValuesOnly of [false, true]) {
    test(`${parent}: comma serialization handles hostile own toString (${encodeValuesOnly})`, () => {
      assertHostileRoundTrip(qs, encodeValuesOnly);
    });
  }

  test(`${parent}: valid serialization and deliberate caller errors remain observable`, () => {
    expect(qs.stringify({ a: ["x", "y"] }, { arrayFormat: "comma" })).toBe("a=x%2Cy");
    expect(qs.stringify({ a: [{ toString: () => "z" }] }, { arrayFormat: "comma" })).toBe("a=z");
    const callerError = new Error("deliberate caller conversion failure");
    expect(() => qs.stringify({ a: [{ toString: () => { throw callerError; } }] }, {
      arrayFormat: "comma",
    })).toThrow(callerError);
  });
}

async function withExpress(operation) {
  const app = express();
  app.set("query parser", "extended");
  app.use(express.urlencoded({ extended: true }));
  const qs = expressDependencies("qs");
  app.all("/roundtrip", (req, res) => {
    res.send(qs.stringify(req.method === "GET" ? req.query : req.body, { arrayFormat: "comma" }));
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    await operation(`http://127.0.0.1:${server.address().port}/roundtrip`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function assertHttpRoundTrip(url, method) {
  const body = "a[0][toString]=x";
  const response = await fetch(method === "GET" ? `${url}?${body}` : url, method === "GET" ? {} : {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  expect(response.status).toBe(constants.HTTP_STATUS_OK);
  expect(expressDependencies("qs").parse(await response.text())).toEqual({ a: "[object Object]" });
}

for (const method of ["GET", "POST"]) {
  test(`real Express ${method}: parsed hostile input round-trips successfully`, async () => {
    await withExpress((url) => assertHttpRoundTrip(url, method));
  });
}
