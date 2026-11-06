import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { PlayIcon, TrashIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { useI18n } from "../i18n";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { ImportDatasetDialog } from "./evals/ImportDatasetDialog";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";
import { EVALS_BASE, EvalsTabs, sourceLabel, timeAgo, type EvalDataset } from "./evals/shared";

export function EvalDatasetsList() {
  const nav = useNavigate();
  const { api } = useApi();
  const { t } = useI18n();
  const m = t.evals;
  const [showImport, setShowImport] = useState(false);
  const [runDatasetId, setRunDatasetId] = useState<string | null>(null);

  const { data, isLoading, refetch } = useApiQuery<{ data: EvalDataset[] }>(`${EVALS_BASE}/datasets`);
  const datasets = data?.data ?? [];

  const columns = useMemo<ColumnDef<EvalDataset>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: t.common.name,
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "source",
        accessorFn: (d) => d.source.type,
        header: m.source,
        cell: ({ row }) => <span className="text-xs text-fg-muted">{sourceLabel(t, row.original.source)}</span>,
      },
      {
        id: "tasks",
        accessorKey: "task_count",
        header: m.tasks,
        cell: ({ row }) => <span className="tabular-nums text-fg-muted">{row.original.task_count}</span>,
      },
      {
        id: "runnable",
        accessorKey: "runnable_count",
        header: m.runnable,
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span className={`tabular-nums ${d.runnable_count < d.task_count ? "text-warning" : "text-fg-muted"}`}>
              {d.runnable_count}
            </span>
          );
        },
      },
      {
        id: "created",
        accessorKey: "created_at",
        header: t.common.created,
        cell: ({ row }) => (
          <span className="text-fg-muted" title={row.original.created_at}>{timeAgo(row.original.created_at)}</span>
        ),
      },
    ],
    [t, m],
  );

  return (
    <DataTable<EvalDataset>
      headerActions={<EvalsTabs t={t} />}
      createLabel={m.importDataset}
      onCreate={() => setShowImport(true)}
      data={datasets}
      loading={isLoading}
      getRowId={(d) => d.id}
      onRowClick={(d) => nav(`/evals/datasets/${d.id}`)}
      rowActions={(d) => [
        {
          label: m.run,
          icon: <PlayIcon className="size-4" />,
          disabled: d.runnable_count === 0,
          onSelect: () => setRunDatasetId(d.id),
        },
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: async () => {
            if (!confirm(m.confirmDeleteDataset)) return;
            try {
              await api(`${EVALS_BASE}/datasets/${d.id}`, { method: "DELETE" });
              void refetch();
            } catch { /* toasted by useApi */ }
          },
        },
      ]}
      columns={columns}
      emptyTitle={m.noDatasetsYet}
      emptyKind="eval"
      emptySubtitle={m.noDatasetsHint}
      emptyAction={<Button onClick={() => setShowImport(true)}>{m.importDataset}</Button>}
    >
      <ImportDatasetDialog open={showImport} onClose={() => setShowImport(false)} />
      <NewEvalRunDialog
        open={runDatasetId !== null}
        onClose={() => setRunDatasetId(null)}
        initialDatasetId={runDatasetId ?? undefined}
      />
    </DataTable>
  );
}
