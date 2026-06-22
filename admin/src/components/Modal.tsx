import React from "react";
import { Modal as CarbonModal } from "@carbon/react";

interface ModalProps {
  title: string;
  children: React.ReactNode;
  onConfirm?: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  confirmDestructive?: boolean;
  disabled?: boolean;
}

export function Modal({
  title,
  children,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
  confirmDestructive = false,
  disabled = false,
}: ModalProps) {
  if (!onConfirm) {
    return (
      <CarbonModal
        open
        passiveModal
        modalHeading={title}
        onRequestClose={onCancel}
      >
        {children}
      </CarbonModal>
    );
  }

  return (
    <CarbonModal
      open
      danger={confirmDestructive}
      modalHeading={title}
      primaryButtonText={confirmLabel}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={disabled}
      onRequestSubmit={onConfirm}
      onRequestClose={onCancel}
      onSecondarySubmit={onCancel}
    >
      {children}
    </CarbonModal>
  );
}
