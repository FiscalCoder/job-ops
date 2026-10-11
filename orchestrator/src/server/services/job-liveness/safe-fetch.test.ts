import { describe, expect, it, vi } from "vitest";
import {
  fetchPublicPage,
  isPublicAddress,
  resolvePublicTarget,
  UnsafeUrlError,
} from "./safe-fetch";

const PUBLIC_ADDRESS = "93.184.216.34";
const publicHost = async () => [PUBLIC_ADDRESS];

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.9",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::",
    "::1",
    "::7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "fd00::1",
    "fe80::1",
    "not-an-ip",
  ])("rejects %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    PUBLIC_ADDRESS,
    "8.8.8.8",
    "2606:4700:4700::1111",
  ])("accepts %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("resolvePublicTarget", () => {
  it("rejects non-http schemes and malformed URLs", async () => {
    await expect(resolvePublicTarget("file:///etc/passwd")).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(resolvePublicTarget("not a url")).rejects.toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects literal and resolved private addresses", async () => {
    await expect(
      resolvePublicTarget("http://127.0.0.1:3001/admin"),
    ).rejects.toThrow(UnsafeUrlError);
    await expect(resolvePublicTarget("http://[::127.0.0.1]/")).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(
      resolvePublicTarget("https://internal.example.com/", async () => [
        PUBLIC_ADDRESS,
        "10.0.0.5",
      ]),
    ).rejects.toThrow(UnsafeUrlError);
    await expect(
      resolvePublicTarget("https://nowhere.example.com/", async () => []),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("returns the validated address to pin the connection to", async () => {
    const target = await resolvePublicTarget(
      "https://jobs.example.com/1",
      publicHost,
    );
    expect(target.url.hostname).toBe("jobs.example.com");
    expect(target.address).toBe(PUBLIC_ADDRESS);
    expect(target.family).toBe(4);
  });
});

describe("fetchPublicPage", () => {
  it("follows redirects, pinning every hop to its validated address", async () => {
    const requestPinned = vi
      .fn()
      .mockResolvedValueOnce({ status: 302, location: "/jobs", body: "" })
      .mockResolvedValueOnce({
        status: 200,
        location: null,
        body: "<html>listing</html>",
      });

    const page = await fetchPublicPage("https://jobs.example.com/jobs/1", {
      timeoutMs: 1000,
      requestPinned,
      resolveHost: publicHost,
    });

    expect(page).toEqual({
      finalUrl: "https://jobs.example.com/jobs",
      status: 200,
      body: "<html>listing</html>",
    });
    expect(requestPinned).toHaveBeenCalledTimes(2);
    for (const [target] of requestPinned.mock.calls) {
      expect(target.address).toBe(PUBLIC_ADDRESS);
    }
  });

  it("refuses a redirect into a private network", async () => {
    const requestPinned = vi.fn().mockResolvedValueOnce({
      status: 302,
      location: "http://169.254.169.254/latest",
      body: "",
    });

    await expect(
      fetchPublicPage("https://jobs.example.com/jobs/1", {
        timeoutMs: 1000,
        requestPinned,
        resolveHost: publicHost,
      }),
    ).rejects.toThrow(UnsafeUrlError);
    expect(requestPinned).toHaveBeenCalledTimes(1);
  });

  it("gives up on redirect loops", async () => {
    const requestPinned = vi.fn(async () => ({
      status: 302,
      location: "/loop",
      body: "",
    }));

    await expect(
      fetchPublicPage("https://jobs.example.com/loop", {
        timeoutMs: 1000,
        requestPinned,
        resolveHost: publicHost,
      }),
    ).rejects.toThrow(/redirected more than/);
  });

  it("times out a stalled DNS lookup", async () => {
    await expect(
      fetchPublicPage("https://jobs.example.com/1", {
        timeoutMs: 20,
        requestPinned: vi.fn(),
        resolveHost: () => new Promise<string[]>(() => undefined),
      }),
    ).rejects.toThrow();
  });
});
