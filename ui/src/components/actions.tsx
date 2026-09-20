import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, cancelRun, type UnsupportedAction } from "@/lib/api";

/**
 * An action the engine has no call for. It renders disabled with the engine's
 * own reason, rather than being hidden or wired to something that pretends to
 * work: the operator should be able to see that the button exists and why it
 * cannot do anything yet.
 */
export function UnsupportedButton({ label, action }: { label: string; action: UnsupportedAction }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // `aria-disabled`, not `disabled`: a disabled button receives no
          // pointer events, so the tooltip that explains why it is disabled
          // could never open — and a wrapper around it anchors the tooltip to
          // the wrapper, not to the button. The trigger is the button itself.
          <Button
            variant="outline"
            size="sm"
            aria-disabled
            className="cursor-not-allowed opacity-50"
            onClick={(event) => event.preventDefault()}
          />
        }
      >
        {label}
      </TooltipTrigger>
      {/* The shipped popup is an inline-flex row; two paragraphs need a column,
          which is a class on the content, not an edit to the component. */}
      <TooltipContent className="max-w-80 flex-col items-start gap-1 text-xs">
        <p className="font-mono">{action.reason}</p>
        <p>{action.message}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Cancel, behind a confirmation. It records
 * `run.terminated{outcome:"cancelled"}` through the same call `woof run cancel`
 * makes; a scheduler still hosting the run stops at its next tick.
 */
export function CancelAction({ runId, disabled }: { runId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => cancelRun(runId, "cancelled from the woof web UI"),
    onSuccess: async () => {
      setOpen(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["run", runId] }),
        client.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    },
  });
  const failure = mutation.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) mutation.reset();
      }}
    >
      <Button
        variant="destructive"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={disabled ? "this run has already ended" : undefined}
      >
        Cancel run
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {runId}?</DialogTitle>
          <DialogDescription>
            This records run.terminated&#123;outcome:&quot;cancelled&quot;&#125; in the run journal.
            A scheduler still hosting the run stops at its next tick and late submissions are
            refused. It cannot be undone: there is no resume.
          </DialogDescription>
        </DialogHeader>
        {failure ? (
          <p className="bg-fail-subtle text-fail rounded-md p-2 font-mono text-xs">
            {failure instanceof ApiError
              ? `${failure.reason}: ${failure.message}`
              : failure.message}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Keep running</DialogClose>
          <Button
            variant="destructive"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Cancelling…" : "Cancel run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
