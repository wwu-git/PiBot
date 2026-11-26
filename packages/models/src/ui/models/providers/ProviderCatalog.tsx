// Displays searchable provider tiles and configured providers.
import { MAGPIE_PROVIDER, type Provider, providerFamily } from "@pibot/models-contract/full";
import { setupStyles as styles, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { providerIdentity } from "../../setup/operations.ts";
import modelStyles from "../models.module.css";
import { modelCountText } from "./model-count.ts";
import { ProviderTile } from "./ProviderTile.tsx";
import {
  groupedProviderCatalog,
  providerGroups as groups,
  namedProviders,
  providerCatalog,
} from "./provider-catalog.ts";
import { providerMonogram } from "./provider-monogram.ts";

export function ProviderCatalog({
  providers,
  selection,
  disabled,
  onSelect,
  initialGroup = "common",
  magpieDetected = false,
  newModels,
  onAddModels,
}: {
  providers: Provider[];
  selection?: string;
  disabled: boolean;
  onSelect(provider: Provider, button: HTMLElement): void;
  initialGroup?: (typeof groups)[number];
  magpieDetected?: boolean;
  /** Model ids a saved custom provider offers beyond its saved list. */
  newModels?: ReadonlyMap<string, string[]>;
  onAddModels?(provider: Provider, ids: string[], button: HTMLElement): void;
}) {
  const t = useT();
  const [group, setGroup] = useState(initialGroup);
  const [search, setSearch] = useState("");
  const named = namedProviders(
    providers,
    t("chatgpt.title"),
    t("chatgpt.codex.title"),
    t("models.magpie.name"),
  );
  const catalog = groupedProviderCatalog(
    providerCatalog(named, t("setup.customLabel"), t("models.payAsYouGo")),
  );
  const configured = providerCatalog(named, t("setup.customLabel"), t("models.payAsYouGo"))
    .filter((provider) => provider.configured)
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const query = search.trim().toLowerCase();
  const visible = catalog.filter(
    (provider) =>
      (provider.id !== MAGPIE_PROVIDER.id || magpieDetected) &&
      (query
        ? `${provider.id} ${provider.name} ${t(`models.auth.${provider.auth}`)}`
            .toLowerCase()
            .includes(query)
        : group === "all" || provider.group === group),
  );
  const renderProvider = (provider: Provider, saved = false) => (
    <ProviderTile
      key={providerIdentity(provider)}
      selected={providerIdentity(provider) === selection}
      add={provider.id === "new-custom"}
      saved={saved}
      title={provider.unavailableReason ? t(`errors.${provider.unavailableReason}`) : undefined}
      disabled={disabled || !provider.available}
      onClick={(event) => onSelect(provider, event.currentTarget)}
      group={provider.group}
      monogram={providerMonogram(provider.id, provider.name)}
      name={
        <>
          {provider.name}
          {saved && provider.auth !== "custom" && providerFamily(provider.id)
            ? ` · ${t(`models.region.${providerFamily(provider.id)?.variants.find(([id]) => id === provider.id)?.[1] ?? "global"}`)}`
            : ""}
        </>
      }
      note={
        !provider.available
          ? t(
              provider.unavailableReason
                ? `errors.${provider.unavailableReason}`
                : "common.comingSoon",
            )
          : saved
            ? provider.auth === "oauth"
              ? t("auth.state.connected")
              : provider.keyHint === undefined
                ? t("setup.saved")
                : t("models.keySaved", { hint: provider.keyHint })
            : `${t(`models.auth.${provider.auth}`)} · ${provider.available ? modelCountText(provider, t) : t("common.comingSoon")}`
      }
    >
      {!saved && provider.configured && (
        <span role="img" className={modelStyles.configuredDot} aria-label={t("setup.saved")} />
      )}
    </ProviderTile>
  );
  return (
    <div className={modelStyles.modelsList}>
      <p className={modelStyles.subtitle}>
        {t("setup.catalogNote", {
          count: providers.filter((provider) => provider.auth !== "custom").length,
        })}
      </p>
      <section className={modelStyles.providerSection}>
        <h2>
          {t("models.configured")} · {configured.length}
        </h2>
        {configured.length ? (
          <div className={modelStyles.configuredProviders}>
            {configured.map((provider) => {
              const fresh = newModels?.get(provider.id);
              if (!fresh?.length || !onAddModels) return renderProvider(provider, true);
              return (
                <div key={providerIdentity(provider)} className={modelStyles.tileWithHint}>
                  {renderProvider(provider, true)}
                  <p className={modelStyles.newModels}>
                    <span>
                      {t(fresh.length === 1 ? "models.newModels.one" : "models.newModels", {
                        count: fresh.length,
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      aria-label={`${t("models.newModels.add")} · ${provider.name}`}
                      onClick={(event) => onAddModels(provider, fresh, event.currentTarget)}
                    >
                      {t("models.newModels.add")}
                    </Button>
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className={styles.note}>{t("models.noConfigured")}</p>
        )}
      </section>
      <section className={modelStyles.providerSection}>
        <div className={modelStyles.sectionHeading}>
          <h2>{t("models.catalog")}</h2>
          <input
            className={modelStyles.providerSearch}
            aria-label={t("models.search")}
            placeholder={t("models.search")}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <fieldset className={modelStyles.groups} aria-label={t("models.groups")}>
          {groups.map((item) => (
            <button
              key={item}
              type="button"
              title={t(`models.group.${item}`)}
              aria-label={
                t(`models.groupShort.${item}`) === t(`models.group.${item}`)
                  ? t(`models.group.${item}`)
                  : `${t(`models.groupShort.${item}`)}: ${t(`models.group.${item}`)}`
              }
              aria-pressed={group === item}
              onClick={() => setGroup(item)}
            >
              {t(`models.groupShort.${item}`)}
            </button>
          ))}
        </fieldset>
        <div className={modelStyles.providers}>
          {visible.map((provider) => renderProvider(provider))}
        </div>
        {!visible.length && <p className={styles.note}>{t("models.noResults")}</p>}
      </section>
    </div>
  );
}
