import { Dispatch, SetStateAction } from "react";

interface PaginationProps {
  page: number;
  totalPages: number;
  loading: boolean;
  onPageChange: Dispatch<SetStateAction<number>>;
  info?: string;
}

export function Pagination({ page, totalPages, loading, onPageChange, info }: PaginationProps) {
  if (totalPages <= 1) return null;
  return (
    <div className="pagination">
      <button
        onClick={() => onPageChange((p) => Math.max(1, p - 1))}
        disabled={page === 1 || loading}
        className="btn btn-sm"
      >
        Previous
      </button>
      <span className="pagination-info">
        Page {page} of {totalPages}{info ? ` (${info})` : ""}
      </span>
      <button
        onClick={() => onPageChange((p) => Math.min(totalPages, p + 1))}
        disabled={page === totalPages || loading}
        className="btn btn-sm"
      >
        Next
      </button>
    </div>
  );
}
