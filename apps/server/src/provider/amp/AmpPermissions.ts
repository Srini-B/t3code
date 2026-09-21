// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { AmpPermissionRequest } from "./AmpProtocol.ts";

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(AmpPermissionRequest));
const MAX_REQUEST_BYTES = 1024 * 1024;

const permissionPreload = `
if (process.env.AGENT_TOOL_NAME && process.argv.length === 1 && process.env.T3_AMP_PERMISSION_TOKEN) {
  const fail = (detail) => { process.stderr.write(detail + '\\n'); process.exit(2); };
  try {
    const input = require('node:fs').readFileSync(0, 'utf8');
    if (Buffer.byteLength(input) > ${MAX_REQUEST_BYTES}) fail('Amp permission request is too large.');
    const payload = JSON.stringify({ tool: process.env.AGENT_TOOL_NAME, input: JSON.parse(input) });
    const request = require('node:http').request(process.env.T3_AMP_PERMISSION_URL, {
      method: 'POST', headers: {
        Authorization: 'Bearer ' + process.env.T3_AMP_PERMISSION_TOKEN,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) fail('Invalid Amp permission response.');
      });
      response.on('end', () => {
        try {
          if (response.statusCode === 200 && JSON.parse(body).allow === true) process.exit(0);
        } catch {}
        fail('T3 Code denied this tool call.');
      });
      response.on('error', () => fail('Amp permission response failed.'));
    });
    request.setTimeout(600000, () => { request.destroy(); fail('Amp permission request timed out.'); });
    request.on('error', () => fail('T3 Code permission service is unavailable.'));
    request.end(payload);
  } catch { fail('Invalid Amp permission request.'); }
}
`;

export async function startAmpPermissions(input: {
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onRequest: (request: AmpPermissionRequest) => Promise<boolean>;
}) {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const preload = NodePath.join(input.directory, "permission-preload.cjs");
  await NodeFSP.writeFile(preload, permissionPreload, { mode: 0o600 });
  const pending = new Set<NodeHttp.ServerResponse>();
  const server = NodeHttp.createServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/permission" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(403).end();
      return;
    }
    let body = "";
    let bytes = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        response.writeHead(413).end();
        request.destroy();
      } else body += chunk;
    });
    request.on("error", () => response.destroy());
    request.on("end", () => {
      if (response.destroyed) return;
      let parsed: AmpPermissionRequest;
      try {
        parsed = decodeRequest(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      pending.add(response);
      response.on("close", () => pending.delete(response));
      void input.onRequest(parsed).then(
        (allow) => {
          if (!response.destroyed)
            response
              .writeHead(200, { "Content-Type": "application/json" })
              .end(JSON.stringify({ allow }));
        },
        () => {
          if (!response.destroyed) response.writeHead(503).end();
        },
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Amp permission service did not bind a TCP port.");
  }
  const environment = {
    ...input.environment,
    NODE_OPTIONS: [
      input.environment.NODE_OPTIONS,
      `--require ${JSON.stringify(preload.replaceAll("\\", "/"))}`,
    ]
      .filter(Boolean)
      .join(" "),
    T3_AMP_PERMISSION_URL: `http://127.0.0.1:${address.port}/permission`,
    T3_AMP_PERMISSION_TOKEN: token,
  };
  return {
    delegate: process.execPath,
    environment,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of pending) response.writeHead(503).end();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
