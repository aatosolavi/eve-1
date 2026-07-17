"use client";

import {
  BotIcon,
  BracesIcon,
  ChevronRightIcon,
  FileTextIcon,
  type LucideIcon,
  MessageSquareIcon,
  PlugIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { RegistryFile } from "@/lib/registry/data";
import { cn } from "@/lib/utils";

interface FileViewerProps {
  files: RegistryFile[];
}

interface CategoryStyle {
  color: string;
  icon: LucideIcon;
}

const categoryStyles: Record<string, CategoryStyle> = {
  "agent.ts": { icon: SettingsIcon, color: "text-pink-600" },
  "instructions.md": { icon: FileTextIcon, color: "text-green-600" },
  channels: { icon: MessageSquareIcon, color: "text-blue-600" },
  connections: { icon: PlugIcon, color: "text-rose-500" },
  skills: { icon: FileTextIcon, color: "text-amber-500" },
  tools: { icon: WrenchIcon, color: "text-orange-600" },
  subagents: { icon: BotIcon, color: "text-violet-600" },
  lib: { icon: BracesIcon, color: "text-cyan-600" },
};

const defaultStyle: CategoryStyle = { icon: FileTextIcon, color: "text-gray-700" };
const categoryOrder = [
  "agent.ts",
  "instructions.md",
  "channels",
  "connections",
  "skills",
  "tools",
  "subagents",
  "lib",
];

interface FileEntry {
  file: RegistryFile;
  label: string;
}

interface FolderNode {
  entries: FileEntry[];
  key: string;
  kind: "folder";
  style: CategoryStyle;
}

interface LeafNode {
  file: RegistryFile;
  key: string;
  kind: "leaf";
  style: CategoryStyle;
}

type TreeNode = FolderNode | LeafNode;

const buildTree = (files: RegistryFile[]): TreeNode[] => {
  const folders = new Map<string, FileEntry[]>();
  const leaves = new Map<string, RegistryFile>();

  for (const sourceFile of files) {
    const parts = sourceFile.relativePath.split("/");
    if (parts[0] !== "agent" || parts.length < 2) {
      continue;
    }
    if (parts.length === 2) {
      leaves.set(parts[1], sourceFile);
      continue;
    }

    const directory = parts[1];
    const entries = folders.get(directory) ?? [];
    entries.push({ file: sourceFile, label: parts.slice(2).join("/") });
    folders.set(directory, entries);
  }

  const keys = new Set([...categoryOrder, ...leaves.keys(), ...folders.keys()]);

  return [...keys].flatMap<TreeNode>((key) => {
    const style = categoryStyles[key] ?? defaultStyle;
    const leaf = leaves.get(key);
    if (leaf) {
      return [{ file: leaf, key, kind: "leaf", style }];
    }

    const entries = folders.get(key);
    if (!entries) {
      return [];
    }
    entries.sort((a, b) => a.label.localeCompare(b.label));
    return [{ entries, key, kind: "folder", style }];
  });
};

export const FileViewer = ({ files }: FileViewerProps) => {
  const tree = useMemo(() => buildTree(files), [files]);
  const initialPath = files[0]?.relativePath ?? null;
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    const parts = initialPath?.split("/");
    if (parts && parts.length >= 3) {
      initial.add(parts[1]);
    }
    return initial;
  });
  const selected = files.find((sourceFile) => sourceFile.relativePath === selectedPath);

  const selectFolder = (folder: FolderNode) => {
    setOpenFolders((current) => new Set(current).add(folder.key));
    const firstFile = folder.entries[0]?.file;
    if (firstFile) {
      setSelectedPath(firstFile.relativePath);
    }
  };

  const toggleFolder = (key: string) => {
    setOpenFolders((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="grid overflow-hidden rounded-lg border border-gray-alpha-400 md:grid-cols-[240px_minmax(0,1fr)]">
      <nav aria-label="Template files" className="border-b p-3 md:border-r md:border-b-0">
        <p className="px-2 pb-2 font-mono text-gray-700 text-xs">agent/</p>
        <ul className="space-y-0.5">
          {tree.map((node) => {
            const Icon = node.style.icon;
            if (node.kind === "leaf") {
              const isSelected = node.file.relativePath === selectedPath;
              return (
                <li key={node.key}>
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[13px] transition-colors",
                      isSelected
                        ? "bg-gray-100 text-gray-1000"
                        : "text-gray-800 hover:bg-gray-100/60 hover:text-gray-1000",
                    )}
                    onClick={() => setSelectedPath(node.file.relativePath)}
                    type="button"
                  >
                    <Icon aria-hidden="true" className={cn("size-4 shrink-0", node.style.color)} />
                    <span className="truncate">{node.key}</span>
                  </button>
                </li>
              );
            }

            const isOpen = openFolders.has(node.key);
            const containsSelected = node.entries.some(
              (entry) => entry.file.relativePath === selectedPath,
            );
            return (
              <li key={node.key}>
                <button
                  aria-expanded={isOpen}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[13px] transition-colors",
                    containsSelected
                      ? "text-gray-1000"
                      : "text-gray-800 hover:bg-gray-100/60 hover:text-gray-1000",
                  )}
                  onClick={() => (isOpen ? toggleFolder(node.key) : selectFolder(node))}
                  type="button"
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3 shrink-0 text-gray-700 transition-transform",
                      isOpen ? "rotate-90" : null,
                    )}
                  />
                  <Icon aria-hidden="true" className={cn("size-4 shrink-0", node.style.color)} />
                  <span className="truncate">{node.key}/</span>
                </button>
                {isOpen ? (
                  <ul className="mt-0.5 ml-[18px] space-y-0.5 border-gray-alpha-400 border-l pl-3">
                    {node.entries.map((entry) => {
                      const isSelected = entry.file.relativePath === selectedPath;
                      return (
                        <li key={entry.file.relativePath}>
                          <button
                            className={cn(
                              "w-full truncate rounded px-2 py-1 text-left font-mono text-xs transition-colors",
                              isSelected
                                ? "bg-gray-100 text-gray-1000"
                                : "text-gray-700 hover:bg-gray-100/60 hover:text-gray-1000",
                            )}
                            onClick={() => setSelectedPath(entry.file.relativePath)}
                            type="button"
                          >
                            {entry.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex min-w-0 flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-gray-alpha-400 px-4 py-2">
          <code className="truncate font-mono text-gray-1000 text-sm">
            {selected?.relativePath ?? ""}
          </code>
          <span className="shrink-0 text-[11px] text-gray-700 uppercase tracking-wider">
            {selected?.language ?? ""}
          </span>
        </div>
        <pre className="max-h-[520px] min-h-80 overflow-auto p-4 font-mono text-[13px] text-gray-1000 leading-relaxed">
          {selected?.contents ?? ""}
        </pre>
      </div>
    </div>
  );
};
