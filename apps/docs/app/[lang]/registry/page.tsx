import type { Metadata } from "next";
import { ArrowUpRightIcon } from "lucide-react";
import { translations } from "@/geistdocs";
import { registryEntries } from "@/lib/registry/data";
import { RegistryGallery } from "./registry-gallery";

const title = "Registry";
const description =
  "Discover templates and example agents from the eve community, then deploy one or use its source as a starting point.";

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const RegistryPage = () => (
  <main className="mx-auto w-full max-w-[1080px] px-4 pb-32 sm:px-6">
    <header className="pt-16 pb-10 sm:pt-20 sm:pb-12">
      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <h1 className="font-semibold text-[40px] text-gray-1000 tracking-tighter sm:text-5xl">
            {title}
          </h1>
          <p className="mt-4 max-w-2xl text-gray-900 text-lg leading-relaxed">{description}</p>
        </div>
        <a
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-gray-1000 px-4 font-medium text-background-100 text-sm no-underline transition-opacity hover:opacity-80"
          href="https://github.com/vercel/eve/issues/new?template=registry_submission.yml"
          rel="noopener noreferrer"
          target="_blank"
        >
          Submit a template
          <ArrowUpRightIcon aria-hidden="true" className="size-4" />
        </a>
      </div>
    </header>
    <RegistryGallery entries={registryEntries} />
  </main>
);

export default RegistryPage;
