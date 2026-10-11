import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";

// Exercise the real SDK against a server that rejects optional AWS checksums.
test("custom endpoints preserve uploads without CRC checksum support", async (t) => {
  let requests = [];
  let uploaded;
  const parts = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, url, headers: req.headers, body });
    const checksumHeaders = Object.keys(req.headers).filter((name) =>
      name.startsWith("x-amz-checksum-") ||
      name === "x-amz-sdk-checksum-algorithm" || name === "x-amz-trailer"
    );
    if (checksumHeaders.length || req.headers["content-encoding"]?.includes("aws-chunked")) {
      res.writeHead(400, { "Content-Type": "application/xml" });
      res.end("<Error><Code>InvalidRequest</Code><Message>Checksums unsupported</Message></Error>");
      return;
    }
    const etag = '"' + createHash("md5").update(body).digest("hex") + '"';
    res.setHeader("ETag", etag);
    if (req.method === "POST" && url.searchParams.has("uploads")) {
      res.setHeader("Content-Type", "application/xml");
      res.end("<InitiateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>backup.tar.gz</Key><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>");
    } else if (req.method === "PUT" && url.searchParams.has("partNumber")) {
      parts.set(Number(url.searchParams.get("partNumber")), body);
      res.end();
    } else if (req.method === "POST" && url.searchParams.has("uploadId")) {
      uploaded = Buffer.concat([...parts].sort(([a], [b]) => a - b).map(([, data]) => data));
      res.setHeader("Content-Type", "application/xml");
      res.end('<CompleteMultipartUploadResult><Bucket>test-bucket</Bucket><Key>backup.tar.gz</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>');
    } else if (req.method === "PUT") {
      uploaded = body;
      res.end();
    } else {
      res.writeHead(500);
      res.end("Unexpected request");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const directory = await mkdtemp(join(tmpdir(), "backup-s3-test-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    AWS_S3_BUCKET: "test-bucket",
    AWS_S3_REGION: "us-east-1",
    AWS_S3_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    AWS_S3_FORCE_PATH_STYLE: "true",
    BACKUP_DATABASE_URL: "postgresql://test:5432/test",
    SUPPORT_OBJECT_LOCK: "false",
    BUCKET_SUBFOLDER: "",
  });
  const { uploadToS3 } = await import("../dist/backup.js");
  const { env } = await import("../dist/env.js");
  for (const scenario of [
    { name: "single-part upload", size: 1024, objectLock: false },
    { name: "multipart upload", size: 6 * 1024 * 1024, objectLock: false },
    { name: "Object Lock retains Content-MD5", size: 1024, objectLock: true },
  ]) {
    await t.test(scenario.name, async () => {
      requests = [];
      uploaded = undefined;
      parts.clear();
      env.SUPPORT_OBJECT_LOCK = scenario.objectLock;
      const data = Buffer.alloc(scenario.size, 0x61);
      const file = join(directory, "backup.tar.gz");
      await writeFile(file, data);
      await uploadToS3({ name: "backup.tar.gz", path: file });
      assert.deepEqual(uploaded, data);
      if (scenario.size > 5 * 1024 * 1024) {
        assert.equal(parts.size, 2);
        assert.ok(requests.some((req) => req.url.searchParams.has("uploadId") && req.method === "POST"));
      } else {
        assert.equal(requests.length, 1);
        if (scenario.objectLock) {
          assert.equal(requests[0].headers["content-md5"], createHash("md5").update(data).digest("base64"));
        }
      }
    });
  }
});
