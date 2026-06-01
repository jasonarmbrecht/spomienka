import React from "react";

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
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        {onConfirm && (
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onCancel} disabled={disabled}>
              Cancel
            </button>
            <button
              className={`btn${confirmDestructive ? " btn-danger" : ""}`}
              onClick={onConfirm}
              disabled={disabled}
            >
              {confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
