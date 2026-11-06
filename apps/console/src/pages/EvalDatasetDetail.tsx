import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { PlayIcon, TrashIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Page } from "../components/Page";
import { useI18n } from "../i18n";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";
import { EVALS_BASE, formatDateTime, sourceLabel, type EvalDataset } from "./evals/shared";

function secs(n: number | null | undefined): string {
  return typeof n === "number" ? `${n}s` : "—";
}

export function EvalDatasetDetail() {
  const { datasetId } = useParams<{ datasetId: string }>();
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [showRun, setShowRun] = useState(false);

  const { data: dataset, isLoading, error } = useApiQuery<EvalDataset>(
    datasetId ? `${EVALS_BASE}/datasets/${datasetId}` : null,
  );

  const remove = async () => {
    if (!dataset || !confirm(m.confirmDeleteDataset)) return;
    try {
      await api(`${EVALS_BASE}/datasets/${dataset.id}`, { method: "DELETE" });
      void queryClient.invalidateQueries({ queryKey: [`${EVALS_BASE}/datasets`] });
      nav("/evals/datasets");
    } catch { /* toasted by useApi */ }
  };

  if (isLoading) return <div className="text-center py-16 text-fg-subtle">{t.common.loading}</div>;
  if (error) {
    return <div className="text-center py-16 text-danger">{error instanceof Error ? error.message : String(error)}</div>;
  }
  if (!dataset) return <div className="text-center py-16 text-fg-subtle">{m.datasetNotFound}</div>;

  const tasks = dataset.tasks ?? [];
  const sep = <span className="text-fg-subtle">·</span>;

  return (
    <Page>
      <div className="console-detail-stack">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-base font-semibold tracking-tight truncate">{dataset.name}</h1>
            <div className="flex-1" />
            <Button size="sm" onClick={() => setShowRun(true)} disabled={dataset.runnable_count === 0}>
              <PlayIcon className="size-4" />
              {m.run}
            </Button>
            <Button size="sm" variant="outline" onClick={remove}>
              <TrashIcon className="size-4" />
              {t.common.delete}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            <span>{m.source} <span className="text-fg">{sourceLabel(t, dataset.source)}</span></span>
            {sep}
            <span>{m.tasks} <span className="text-fg font-medium">{dataset.task_count}</span></span>
            {sep}
            <span>
              {m.runnable}{" "}
              <span className={`font-medium ${dataset.runnable_count < dataset.task_count ? "text-warning" : "text-fg"}`}>
                {dataset.runnable_count}
              </span>
            </span>
            {sep}
            <span>{t.common.created} <span className="text-fg">{formatDateTime(dataset.created_at)}</span></span>
            {sep}
            <span className="font-mono text-xs">{dataset.id}</span>
          </div>
        </div>

        <div className="console-detail-table-wrap" data-testid="eval-dataset-tasks">
          <Table className="console-detail-table">
            <TableHeader variant="wireless">
              <TableRow variant="wireless">
                <TableHead className="text-left px-3">{t.common.name}</TableHead>
                <TableHead className="text-left px-3">{m.image}</TableHead>
                <TableHead className="text-left px-3">{m.imageAlias}</TableHead>
                <TableHead className="text-left px-3">{m.supported}</TableHead>
                <TableHead className="text-left px-3">{m.timeouts}</TableHead>
                <TableHead className="text-left px-3">{m.resources}</TableHead>
                <TableHead className="text-left px-3">{m.hasSolution}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow
                  variant="wireless"
                  key={task.name}
                  data-testid={`eval-dataset-task-${task.name}`}
                  className="bg-bg-surface/60"
                >
                  <TableCell className="px-3 py-2 rounded-l-lg align-top">
                    <div className="font-mono text-xs text-fg">{task.name}</div>
                    {task.instruction_preview && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">{m.instruction}</summary>
                        <pre className="mt-1 p-2 bg-bg-surface/60 rounded text-xs overflow-auto max-h-48 whitespace-pre-wrap text-fg max-w-xl">
                          {task.instruction_preview}
                        </pre>
                      </details>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 font-mono text-xs text-fg-muted align-top whitespace-normal break-all">{task.image}</TableCell>
                  <TableCell className="px-3 py-2 text-xs align-top">
                    {task.image_alias ? (
                      <span className="font-mono text-fg-muted">{task.image_alias}</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-warning-subtle text-warning whitespace-nowrap">
                        {m.noAliasWarning}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs align-top">
                    {task.supported ? (
                      <span className="text-success">{m.supported}</span>
                    ) : (
                      <span className="text-danger" title={task.unsupported_reason}>
                        {m.unsupported}
                        {task.unsupported_reason && (
                          <span className="block text-fg-muted">{task.unsupported_reason}</span>
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums align-top">
                    {secs(task.agent_timeout_sec)} / {secs(task.verifier_timeout_sec)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums align-top">
                    {task.cpus ?? "—"} CPU · {task.memory_mb != null ? `${task.memory_mb} MB` : "—"}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-xs text-fg-muted align-top rounded-r-lg">
                    {task.has_solution ? m.yes : m.no}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      <NewEvalRunDialog open={showRun} onClose={() => setShowRun(false)} initialDatasetId={dataset.id} />
    </Page>
  );
}
