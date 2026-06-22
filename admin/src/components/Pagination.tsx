import { Pagination as CarbonPagination } from "@carbon/react";

interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems?: number;
  pageSize?: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}

export function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize = 50,
  loading,
  onPageChange,
}: PaginationProps) {
  if (totalPages <= 1) return null;
  const itemCount = totalItems ?? totalPages * pageSize;
  return (
    <CarbonPagination
      page={page}
      pageSize={pageSize}
      totalItems={itemCount}
      pageSizes={[pageSize]}
      onChange={({ page: p }) => !loading && onPageChange(p)}
    />
  );
}
