import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface DisconnectButtonProps {
  providerLabel: string;
  disabled: boolean;
  isPending: boolean;
  onConfirm: () => void;
}

export function DisconnectButton({
  providerLabel,
  disabled,
  isPending,
  onConfirm,
}: DisconnectButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={disabled || isPending}
        onClick={() => setOpen(true)}
      >
        {isPending ? "Disconnecting..." : "Disconnect"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {providerLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              Job Ops deletes your saved {providerLabel} login from the server.
              Tasks set to use it stop working until you connect again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirm}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
