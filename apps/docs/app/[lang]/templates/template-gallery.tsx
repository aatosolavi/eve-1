"use client";

import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { Select } from "radix-ui";
import { useMemo, useState } from "react";
import type {
  RegistryCategory,
  RegistryEntry,
  RegistryIntegration,
  RegistrySource,
} from "@/lib/registry/data";
import { integrationIcons } from "./integration-icons";

const ALL = "all" as const;

type FilterValue<T extends string> = typeof ALL | T;

const categories: RegistryCategory[] = ["Chat", "Collaboration", "Example"];
const integrations: RegistryIntegration[] = [
  "HTTP API",
  "Linear",
  "Notion",
  "Sentry",
  "Slack",
  "Web chat",
];
const sources: RegistrySource[] = ["GitHub", "Vercel Templates"];

interface TemplateGalleryProps {
  entries: RegistryEntry[];
}

interface FilterSelectProps<T extends string> {
  allLabel: string;
  label: string;
  onChange: (value: FilterValue<T>) => void;
  options: T[];
  value: FilterValue<T>;
}

const FilterSelect = <T extends string>({
  allLabel,
  label,
  onChange,
  options,
  value,
}: FilterSelectProps<T>) => (
  <Select.Root onValueChange={(nextValue) => onChange(nextValue as FilterValue<T>)} value={value}>
    <Select.Trigger
      aria-label={label}
      className="flex h-10 w-full min-w-0 items-center justify-between gap-3 rounded-md border border-gray-alpha-400 bg-background-100 px-3 text-gray-1000 text-sm outline-none transition-colors hover:border-gray-alpha-500 focus:border-gray-700 data-[state=open]:border-gray-700"
    >
      <Select.Value />
      <Select.Icon asChild>
        <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-gray-700" />
      </Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content
        align="start"
        className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-gray-alpha-400 bg-background-100 p-1 shadow-lg shadow-black/20"
        position="popper"
        sideOffset={6}
      >
        <Select.Viewport>
          <FilterOption label={allLabel} value={ALL} />
          {options.map((option) => (
            <FilterOption key={option} label={option} value={option} />
          ))}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
);

const FilterOption = ({ label, value }: { label: string; value: string }) => (
  <Select.Item
    className="relative flex h-8 cursor-default select-none items-center rounded px-2 pr-8 text-gray-900 text-sm outline-none data-[highlighted]:bg-gray-100 data-[highlighted]:text-gray-1000"
    value={value}
  >
    <Select.ItemText>{label}</Select.ItemText>
    <Select.ItemIndicator className="absolute right-2 inline-flex items-center">
      <CheckIcon aria-hidden="true" className="size-3.5 text-gray-1000" />
    </Select.ItemIndicator>
  </Select.Item>
);

const TemplateCard = ({ entry }: { entry: RegistryEntry }) => (
  <article className="group relative flex min-h-44 flex-col rounded-lg border border-gray-alpha-400 bg-background-100 p-5 transition-colors hover:border-gray-alpha-500 hover:bg-gray-100/40">
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="font-medium text-lg text-gray-1000 leading-snug">
          <Link
            className="after:absolute after:inset-0 no-underline"
            href={`/templates/${entry.slug}`}
          >
            {entry.title}
          </Link>
        </h2>
      </div>
      <ArrowUpRightIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-gray-700 transition-colors group-hover:text-gray-1000"
      />
    </div>
    <p className="mt-2 line-clamp-3 text-gray-900 text-sm leading-relaxed">{entry.description}</p>
    <div className="relative mt-auto flex flex-wrap items-center gap-2 pt-5">
      <ul className="flex items-center gap-2">
        {entry.integrations.map((integration) => {
          const Icon = integrationIcons[integration];
          return (
            <li
              className="text-gray-700 transition-colors group-hover:text-gray-1000"
              key={integration}
              title={integration}
            >
              <Icon aria-hidden="true" className="size-4" />
              <span className="sr-only">{integration}</span>
            </li>
          );
        })}
      </ul>
    </div>
  </article>
);

export const TemplateGallery = ({ entries }: TemplateGalleryProps) => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FilterValue<RegistryCategory>>(ALL);
  const [integration, setIntegration] = useState<FilterValue<RegistryIntegration>>(ALL);
  const [source, setSource] = useState<FilterValue<RegistrySource>>(ALL);

  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return entries.filter((entry) => {
      if (category !== ALL && entry.category !== category) {
        return false;
      }
      if (integration !== ALL && !entry.integrations.includes(integration)) {
        return false;
      }
      if (source !== ALL && entry.source !== source) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      return [entry.title, entry.description, entry.category, entry.source, ...entry.integrations]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [category, entries, integration, query, source]);

  const hasFilters = query !== "" || category !== ALL || integration !== ALL || source !== ALL;

  const clearFilters = () => {
    setQuery("");
    setCategory(ALL);
    setIntegration(ALL);
    setSource(ALL);
  };

  return (
    <section aria-label="Templates" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <label className="relative">
          <span className="sr-only">Search templates</span>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-gray-700"
          />
          <input
            className="h-12 w-full rounded-md border border-gray-alpha-400 bg-background-100 pr-4 pl-10 text-gray-1000 text-sm outline-none transition-colors placeholder:text-gray-700 hover:border-gray-alpha-500 focus:border-gray-700"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search templates and examples"
            type="search"
            value={query}
          />
        </label>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          <FilterSelect
            allLabel="All categories"
            label="Filter by category"
            onChange={setCategory}
            options={categories}
            value={category}
          />
          <FilterSelect
            allLabel="All integrations"
            label="Filter by integration"
            onChange={setIntegration}
            options={integrations}
            value={integration}
          />
          <FilterSelect
            allLabel="All sources"
            label="Filter by source"
            onChange={setSource}
            options={sources}
            value={source}
          />
        </div>
      </div>

      <div className="flex min-h-5 items-center justify-between gap-4 text-gray-800 text-sm">
        <span>
          {results.length} {results.length === 1 ? "entry" : "entries"}
        </span>
        {hasFilters ? (
          <button
            className="text-gray-900 underline decoration-gray-alpha-500 underline-offset-4 hover:text-gray-1000"
            onClick={clearFilters}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {results.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {results.map((entry) => (
            <TemplateCard entry={entry} key={entry.title} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-gray-alpha-400 py-16 text-center">
          <p className="font-medium text-gray-1000">No templates found</p>
          <p className="text-gray-800 text-sm">Try a different search or filter.</p>
          <button
            className="mt-3 font-medium text-gray-1000 text-sm underline underline-offset-4"
            onClick={clearFilters}
            type="button"
          >
            Clear filters
          </button>
        </div>
      )}
    </section>
  );
};
