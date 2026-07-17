import { ArrowLeftIcon, ArrowUpRightIcon, GitBranchIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { translations } from "@/geistdocs";
import { getRegistryEntry, registryEntries, type RegistryEntry } from "@/lib/registry/data";
import { integrationIcons } from "../integration-icons";
import { FileViewer } from "./file-viewer";

interface PageParams {
  lang: string;
  slug: string;
}

export const generateStaticParams = (): PageParams[] =>
  Object.keys(translations).flatMap((lang) =>
    registryEntries.map((entry) => ({ lang, slug: entry.slug })),
  );

export const dynamicParams = false;

export const generateMetadata = async ({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> => {
  const { slug } = await params;
  const entry = getRegistryEntry(slug);
  return entry
    ? { title: entry.title, description: entry.description }
    : { title: "Template not found" };
};

const TemplateDetailPage = async ({ params }: { params: Promise<PageParams> }) => {
  const { slug } = await params;
  const entry = getRegistryEntry(slug);
  if (!entry) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-[1080px] px-4 pt-12 pb-32 sm:px-6">
      <Link
        className="inline-flex items-center gap-1.5 text-gray-800 text-sm no-underline transition-colors hover:text-gray-1000"
        href="/templates"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        Templates
      </Link>

      <header className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <p className="text-gray-700 text-xs uppercase tracking-wide">{entry.category}</p>
          <h1 className="mt-2 font-semibold text-[40px] text-gray-1000 tracking-tighter sm:text-5xl">
            {entry.title}
          </h1>
          <p className="mt-4 max-w-2xl text-gray-900 text-lg leading-relaxed">
            {entry.description}
          </p>
          <IntegrationList entry={entry} />
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-gray-alpha-400 px-4 font-medium text-gray-1000 text-sm no-underline transition-colors hover:bg-gray-100"
            href={entry.sourceHref}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitBranchIcon aria-hidden="true" className="size-4" />
            Source
          </a>
          <a
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-gray-1000 px-4 font-medium text-background-100 text-sm no-underline transition-opacity hover:opacity-80"
            href={entry.href}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open template
            <ArrowUpRightIcon aria-hidden="true" className="size-4" />
          </a>
        </div>
      </header>

      <section className="mt-12">
        <h2 className="font-semibold text-gray-1000 text-xl tracking-tight">Overview</h2>
        <dl className="mt-4 grid overflow-hidden rounded-lg border border-gray-alpha-400 sm:grid-cols-3 sm:divide-x sm:divide-gray-alpha-400">
          <OverviewItem label="Model" value={entry.model} />
          <OverviewItem label="Authored files" value={String(entry.files.length)} />
          <OverviewItem label="Source" value={entry.source} />
        </dl>
      </section>

      <section className="mt-12">
        <div>
          <h2 className="font-semibold text-gray-1000 text-xl tracking-tight">Filesystem</h2>
          <p className="mt-1 text-gray-800 text-sm">
            Browse the authored agent at source revision {entry.sourceRevision.slice(0, 7)}.
          </p>
        </div>
        <div className="mt-4">
          <FileViewer files={entry.files} />
        </div>
      </section>
    </main>
  );
};

const IntegrationList = ({ entry }: { entry: RegistryEntry }) => (
  <ul className="mt-5 flex flex-wrap items-center gap-3">
    {entry.integrations.map((integration) => {
      const Icon = integrationIcons[integration];
      return (
        <li className="inline-flex items-center gap-1.5 text-gray-800 text-sm" key={integration}>
          <Icon aria-hidden="true" className="size-4" />
          {integration}
        </li>
      );
    })}
  </ul>
);

const OverviewItem = ({ label, value }: { label: string; value: string }) => (
  <div className="border-gray-alpha-400 border-b p-4 last:border-b-0 sm:border-b-0">
    <dt className="text-gray-700 text-xs uppercase tracking-wide">{label}</dt>
    <dd className="mt-1 truncate font-mono text-gray-1000 text-sm">{value}</dd>
  </div>
);

export default TemplateDetailPage;
