import { useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "../../components/Field";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { useI18n } from "../../i18n";
import { useApi } from "../../lib/api";
import { useApiQuery, useQueryClient } from "../../lib/useApiQuery";
import { useManagedApi } from "../../lib/useManagedApi";
import {
  EVALS_BASE,
  type BuiltinEvalDataset,
  type CreateEvalDatasetRequest,
  type EvalDataset,
} from "./shared";

type SourceType = "builtin" | "registry" | "upload";

function splitNames(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

export function ImportDatasetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  const [sourceType, setSourceType] = useState<SourceType>("builtin");
  const [name, setName] = useState("");
  const [builtin, setBuiltin] = useState("");
  const [registryName, setRegistryName] = useState("");
  const [version, setVersion] = useState("");
  const [registryUrl, setRegistryUrl] = useState("");
  const [taskNames, setTaskNames] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "importing">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const { data: builtinsRes } = useApiQuery<{ data: BuiltinEvalDataset[] }>(
    open ? `${EVALS_BASE}/datasets/builtin` : null,
  );
  const builtins = builtinsRes?.data ?? [];

  const busy = phase !== "idle";
  const canSubmit =
    !busy &&
    (sourceType === "builtin"
      ? !!builtin
      : sourceType === "registry"
        ? registryName.trim() !== ""
        : !!file);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      let body: CreateEvalDatasetRequest;
      const names = splitNames(taskNames);
      const nameField = name.trim() ? { name: name.trim() } : {};
      if (sourceType === "upload") {
        setPhase("uploading");
        const uploaded = await managedApi.files.upload({ file: file! });
        body = { ...nameField, source: { type: "upload", file_id: uploaded.id } };
      } else if (sourceType === "registry") {
        body = {
          ...nameField,
          source: {
            type: "registry",
            name: registryName.trim(),
            ...(version.trim() ? { version: version.trim() } : {}),
            ...(registryUrl.trim() ? { registry_url: registryUrl.trim() } : {}),
          },
          ...(names.length > 0 ? { task_names: names } : {}),
        };
      } else {
        body = {
          ...nameField,
          source: { type: "builtin", name: builtin },
          ...(names.length > 0 ? { task_names: names } : {}),
        };
      }
      setPhase("importing");
      const created = await api<EvalDataset>(`${EVALS_BASE}/datasets`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      void queryClient.invalidateQueries({ queryKey: [`${EVALS_BASE}/datasets`] });
      onClose();
      nav(`/evals/datasets/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={m.importDataset}
      subtitle={m.importDatasetSubtitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {phase === "uploading" ? m.uploading : phase === "importing" ? m.importing : m.import}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={m.source}>
          <Select
            id="eval-dataset-source"
            value={sourceType}
            onValueChange={(v) => setSourceType(v as SourceType)}
          >
            <SelectOption value="builtin">{m.sourceBuiltin}</SelectOption>
            <SelectOption value="registry">{m.sourceRegistry}</SelectOption>
            <SelectOption value="upload">{m.sourceUpload}</SelectOption>
          </Select>
        </Field>

        {sourceType === "builtin" && (
          <Field
            label={m.builtinDataset}
            hint={
              builtins.length === 0
                ? m.noBuiltins
                : builtins.find((b) => b.name === builtin)?.description
            }
          >
            <Select
              id="eval-dataset-builtin"
              value={builtin}
              onValueChange={setBuiltin}
              placeholder={m.selectBuiltin}
            >
              {builtins.map((b) => (
                <SelectOption key={b.name} value={b.name}>
                  {b.name} ({b.task_count})
                </SelectOption>
              ))}
            </Select>
          </Field>
        )}

        {sourceType === "registry" && (
          <>
            <Field label={m.registryName}>
              <Input
                id="eval-dataset-registry-name"
                value={registryName}
                onChange={(e) => setRegistryName(e.target.value)}
                placeholder="terminal-bench"
                autoComplete="off"
              />
            </Field>
            <Field label={m.registryVersion}>
              <Input
                id="eval-dataset-registry-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label={m.registryUrl} hint={m.registryUrlHint}>
              <Input
                id="eval-dataset-registry-url"
                value={registryUrl}
                onChange={(e) => setRegistryUrl(e.target.value)}
                placeholder="https://"
                autoComplete="off"
              />
            </Field>
          </>
        )}

        {sourceType !== "upload" && (
          <Field label={m.taskNames} hint={m.taskNamesHint}>
            <Input
              id="eval-dataset-task-names"
              value={taskNames}
              onChange={(e) => setTaskNames(e.target.value)}
              placeholder="hello-world, fix-git"
              autoComplete="off"
            />
          </Field>
        )}

        {sourceType === "upload" && (
          <Field label={m.archive} hint={m.archiveHint}>
            <Input
              id="eval-dataset-archive"
              type="file"
              accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
        )}

        <Field label={m.datasetName} hint={m.datasetNameHint}>
          <Input
            id="eval-dataset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </Field>

        {error && (
          <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
