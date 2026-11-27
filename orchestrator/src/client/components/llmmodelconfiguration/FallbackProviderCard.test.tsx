import * as api from "@client/api";
import { render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FallbackProviderCard from "./FallbackProviderCard";

vi.mock("@client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@client/api")>()),
  getLlmModels: vi.fn(),
}));

const noop = () => undefined;

function renderCard(provider: string, baseUrl: string, onRender: () => void) {
  return render(
    <Profiler id="fallback" onRender={onRender}>
      <FallbackProviderCard
        mode="settings"
        enabled
        provider={provider}
        baseUrl={baseUrl}
        model=""
        apiKeyValue=""
        apiKeyHint="sk-4"
        disabled={false}
        onEnabledChange={noop}
        onProviderChange={noop}
        onBaseUrlChange={noop}
        onModelChange={noop}
        onApiKeyChange={noop}
      />
    </Profiler>,
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("FallbackProviderCard (saved provider, render-loop regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getLlmModels).mockResolvedValue(["gpt-5.4-mini"]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("settles for a provider without model suggestions (DeepSeek)", async () => {
    const onRender = vi.fn();
    renderCard("openai_compatible", "https://api.deepseek.com", onRender);
    await settle();
    const renders = onRender.mock.calls.length;
    await settle();
    expect(onRender.mock.calls.length).toBe(renders);
    expect(renders).toBeLessThan(10);
    expect(api.getLlmModels).not.toHaveBeenCalled();
  });

  it("loads the model list once for a provider with suggestions", async () => {
    const onRender = vi.fn();
    renderCard("openai", "", onRender);
    await waitFor(() => expect(api.getLlmModels).toHaveBeenCalled());
    await settle();
    expect(api.getLlmModels).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "data-state",
      "checked",
    );
  });
});
