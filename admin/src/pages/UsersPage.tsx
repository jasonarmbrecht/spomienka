import { FormEvent, useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { Notification } from "../components/Notification";
import { useNotification } from "../hooks/useNotification";
import { isValidEmail, validatePassword } from "../utils";
import {
  Grid,
  Column,
  Heading,
  Button,
  TextInput,
  PasswordInput,
  Select,
  SelectItem,
  InlineNotification,
  DataTableSkeleton,
  Stack,
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
} from "@carbon/react";
import { Edit, TrashCan, Password } from "@carbon/icons-react";

type UserRecord = {
  id: string;
  email: string;
  name?: string;
  role?: string;
  created: string;
};

const headers = [
  { key: "email", header: "Email" },
  { key: "name", header: "Name" },
  { key: "role", header: "Role" },
  { key: "created", header: "Created" },
  { key: "actions", header: "Actions" },
];

export function UsersPage() {
  const { user } = useAuth();
  const { error, message, setError, clear, showError, showMessage } = useNotification();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [resettingPasswordUserId, setResettingPasswordUserId] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [creating, setCreating] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const [editEmail, setEditEmail] = useState("");
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<"user" | "admin">("user");
  const [newPassword, setNewPassword] = useState("");

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pb.collection("users").getList<UserRecord>(1, 100, {
        sort: "-created",
        requestKey: null,
      });
      setUsers(res.items);
    } catch (err) {
      showError(err, "Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const createUser = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!email.trim() || !password.trim()) { setError("Email and password are required"); return; }
    if (!isValidEmail(email)) { setError("Please enter a valid email address"); return; }
    const passwordError = validatePassword(password);
    if (passwordError) { setError(passwordError); return; }

    setCreating(true);
    clear();

    try {
      await pb.collection("users").create({
        email: email.trim(),
        password,
        passwordConfirm: password,
        name: name.trim() || undefined,
        role,
      });
      setShowCreateModal(false);
      showMessage(`User "${email}" created successfully`);
      setEmail(""); setPassword(""); setName(""); setRole("user");
      await loadUsers();
    } catch (err) {
      showError(err, "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  const startEditUser = (userRecord: UserRecord) => {
    setEditingUserId(userRecord.id);
    setEditEmail(userRecord.email);
    setEditName(userRecord.name || "");
    setEditRole((userRecord.role || "user") as "user" | "admin");
  };

  const cancelEditUser = () => {
    setEditingUserId(null);
    setEditEmail(""); setEditName(""); setEditRole("user");
  };

  const saveEditUser = async (userId: string) => {
    if (!editEmail.trim()) { setError("Email is required"); return; }
    setError(null);
    try {
      await pb.collection("users").update(userId, {
        email: editEmail.trim(),
        name: editName.trim() || undefined,
        role: editRole,
      });
      await loadUsers();
      setEditingUserId(null);
      showMessage("User updated successfully");
    } catch (err) {
      showError(err, "Failed to update user");
    }
  };

  const resetPassword = async (userId: string) => {
    if (!newPassword.trim() || newPassword.length < 8) { setError("Password must be at least 8 characters"); return; }
    setError(null);
    try {
      await pb.collection("users").update(userId, { password: newPassword, passwordConfirm: newPassword });
      setResettingPasswordUserId(null);
      setNewPassword("");
      showMessage("Password reset successfully");
    } catch (err) {
      showError(err, "Failed to reset password");
    }
  };

  const deleteUser = async (userId: string) => {
    if (userId === user?.id) { setError("You cannot delete your own account"); setUserToDelete(null); return; }
    const adminCount = users.filter((u) => u.role === "admin").length;
    const target = users.find((u) => u.id === userId);
    if (target?.role === "admin" && adminCount === 1) { setError("Cannot delete the last admin user"); setUserToDelete(null); return; }
    setError(null);
    try {
      await pb.collection("users").delete(userId);
      await loadUsers();
      setUserToDelete(null);
      showMessage("User deleted successfully");
    } catch (err) {
      showError(err, "Failed to delete user");
    }
  };

  const rows = users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name || "—",
    role: u.role || "user",
    created: new Date(u.created).toLocaleDateString(),
    actions: u.id,
  }));

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <Heading>Users</Heading>
        </div>

        <Notification error={error} message={message} />

        {showCreateModal && (
          <Modal
            title="Create New User"
            onConfirm={() => createUser()}
            onCancel={() => { setShowCreateModal(false); setEmail(""); setPassword(""); setName(""); setRole("user"); setError(null); }}
            confirmLabel={creating ? "Creating..." : "Create User"}
            disabled={creating}
          >
            <Stack gap={5}>
              <TextInput
                id="new-user-email"
                labelText="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
              />
              <PasswordInput
                id="new-user-password"
                labelText="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                minLength={8}
              />
              <TextInput
                id="new-user-name"
                labelText="Display Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="John Doe"
              />
              <Select
                id="new-user-role"
                labelText="Role"
                value={role}
                onChange={(e) => setRole(e.target.value as "user" | "admin")}
              >
                <SelectItem value="user" text="User" />
                <SelectItem value="admin" text="Admin" />
              </Select>
            </Stack>
          </Modal>
        )}

        {resettingPasswordUserId && (
          <Modal
            title="Reset Password"
            onConfirm={() => resetPassword(resettingPasswordUserId)}
            onCancel={() => { setResettingPasswordUserId(null); setNewPassword(""); }}
            confirmLabel="Reset Password"
          >
            <PasswordInput
              id="reset-password"
              labelText="New Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
              minLength={8}
            />
          </Modal>
        )}

        {userToDelete && (
          <Modal
            title="Confirm Deletion"
            onConfirm={() => deleteUser(userToDelete)}
            onCancel={() => setUserToDelete(null)}
            confirmLabel="Delete"
            confirmDestructive
          >
            <p>Are you sure you want to delete this user? This action cannot be undone.</p>
          </Modal>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.5rem" }}>
          <Button kind="primary" size="sm" onClick={() => { setError(null); setShowCreateModal(true); }}>
            + Add User
          </Button>
        </div>

        {loading ? (
          <DataTableSkeleton headers={headers.map((h) => h.header)} rowCount={5} showHeader={false} showToolbar={false} />
        ) : users.length === 0 ? (
          <EmptyState message="No users found." />
        ) : (
          <div style={{ overflowX: "auto" }}>
          <DataTable rows={rows} headers={headers}>
            {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
              <>
                <Table {...getTableProps()} size="md">
                  <TableHead>
                    <TableRow>
                      {tableHeaders.map((header) => (
                        <TableHeader {...getHeaderProps({ header })} key={header.key}>
                          {header.header}
                        </TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tableRows.map((row) => {
                      const u = users.find((usr) => usr.id === row.id)!;
                      const isCurrentUser = u?.id === user?.id;
                      if (editingUserId === row.id) {
                        return (
                          <TableRow {...getRowProps({ row })} key={row.id} isSelected={isCurrentUser}>
                            <TableCell>
                              <TextInput
                                id={`edit-email-${row.id}`}
                                labelText=""
                                hideLabel
                                type="email"
                                value={editEmail}
                                onChange={(e) => setEditEmail(e.target.value)}
                                size="sm"
                              />
                            </TableCell>
                            <TableCell>
                              <TextInput
                                id={`edit-name-${row.id}`}
                                labelText=""
                                hideLabel
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                size="sm"
                              />
                            </TableCell>
                            <TableCell>
                              <Select
                                id={`edit-role-${row.id}`}
                                labelText=""
                                hideLabel
                                value={editRole}
                                onChange={(e) => setEditRole(e.target.value as "user" | "admin")}
                                size="sm"
                              >
                                <SelectItem value="user" text="User" />
                                <SelectItem value="admin" text="Admin" />
                              </Select>
                            </TableCell>
                            <TableCell>{new Date(u.created).toLocaleDateString()}</TableCell>
                            <TableCell>
                              <div style={{ display: "flex", gap: "0.25rem" }}>
                                <Button size="sm" onClick={() => saveEditUser(row.id)}>Save</Button>
                                <Button kind="secondary" size="sm" onClick={cancelEditUser}>Cancel</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      }
                      return (
                        <TableRow {...getRowProps({ row })} key={row.id} isSelected={isCurrentUser}>
                          {row.cells.slice(0, 4).map((cell) => (
                            <TableCell key={cell.id}>{cell.value}</TableCell>
                          ))}
                          <TableCell>
                            <div style={{ display: "flex", gap: "0.25rem" }}>
                              <Button kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit" onClick={() => startEditUser(u)}>
                                Edit
                              </Button>
                              <Button kind="ghost" size="sm" renderIcon={Password} iconDescription="Reset Password" onClick={() => setResettingPasswordUserId(u.id)}>
                                Reset Password
                              </Button>
                              <Button
                                kind="danger--ghost"
                                size="sm"
                                renderIcon={TrashCan}
                                iconDescription="Delete"
                                disabled={isCurrentUser}
                                onClick={() => setUserToDelete(u.id)}
                              >
                                Delete
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </>
            )}
          </DataTable>
          </div>
        )}

        {!loading && users.length > 0 && (
          <div style={{ marginTop: "1rem" }}>
            <InlineNotification
              kind="info"
              title="Your account is highlighted in the table above."
              hideCloseButton
              lowContrast
              style={{ maxInlineSize: "none" }}
            />
          </div>
        )}
      </Column>
    </Grid>
  );
}
