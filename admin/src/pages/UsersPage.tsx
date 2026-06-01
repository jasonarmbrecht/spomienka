import { FormEvent, useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { Modal } from "../components/Modal";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { EmptyState } from "../components/EmptyState";
import { Notification } from "../components/Notification";
import { useNotification } from "../hooks/useNotification";
import { isValidEmail, validatePassword } from "../utils";

type UserRecord = {
  id: string;
  email: string;
  name?: string;
  role?: string;
  created: string;
};

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

    if (!email.trim() || !password.trim()) {
      setError("Email and password are required");
      return;
    }
    if (!isValidEmail(email)) {
      setError("Please enter a valid email address");
      return;
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

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
      setEmail("");
      setPassword("");
      setName("");
      setRole("user");
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
    setEditEmail("");
    setEditName("");
    setEditRole("user");
  };

  const saveEditUser = async (userId: string) => {
    if (!editEmail.trim()) {
      setError("Email is required");
      return;
    }
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
    if (!newPassword.trim() || newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setError(null);
    try {
      await pb.collection("users").update(userId, {
        password: newPassword,
        passwordConfirm: newPassword,
      });
      setResettingPasswordUserId(null);
      setNewPassword("");
      showMessage("Password reset successfully");
    } catch (err) {
      showError(err, "Failed to reset password");
    }
  };

  const deleteUser = async (userId: string) => {
    if (userId === user?.id) {
      setError("You cannot delete your own account");
      setUserToDelete(null);
      return;
    }
    const adminCount = users.filter((u) => u.role === "admin").length;
    const target = users.find((u) => u.id === userId);
    if (target?.role === "admin" && adminCount === 1) {
      setError("Cannot delete the last admin user");
      setUserToDelete(null);
      return;
    }
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

  return (
    <section className="page-wide">
      <div className="section-header">
        <h1>Users</h1>
        <button onClick={() => { setError(null); setShowCreateModal(true); }}>+ Add User</button>
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
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              style={{ width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <label style={{ marginTop: "0.75rem", display: "block" }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              minLength={8}
              style={{ width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <label style={{ marginTop: "0.75rem", display: "block" }}>
            Display Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
              style={{ width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          <label style={{ marginTop: "0.75rem", display: "block" }}>
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "user" | "admin")}
              style={{ width: "100%", marginTop: "0.25rem" }}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
        </Modal>
      )}

      <div className="user-list">
        <h2>Existing Users</h2>
        {loading && <LoadingSpinner label="Loading users..." />}
        {!loading && users.length === 0 && <EmptyState message="No users found." />}
        {users.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.id === user?.id ? "current-user" : ""}>
                  {editingUserId === u.id ? (
                    <>
                      <td>
                        <input
                          type="email"
                          value={editEmail}
                          onChange={(e) => setEditEmail(e.target.value)}
                          style={{ width: "100%", padding: "0.25rem" }}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          style={{ width: "100%", padding: "0.25rem" }}
                        />
                      </td>
                      <td>
                        <select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value as "user" | "admin")}
                          style={{ width: "100%", padding: "0.25rem" }}
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td>{new Date(u.created).toLocaleDateString()}</td>
                      <td>
                        <button onClick={() => saveEditUser(u.id)} className="btn btn-sm">
                          Save
                        </button>
                        <button
                          onClick={cancelEditUser}
                          className="btn btn-secondary btn-sm"
                          style={{ marginLeft: "0.25rem" }}
                        >
                          Cancel
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{u.email}</td>
                      <td>{u.name || "—"}</td>
                      <td>{u.role || "user"}</td>
                      <td>{new Date(u.created).toLocaleDateString()}</td>
                      <td>
                        <button onClick={() => startEditUser(u)} className="btn btn-sm">
                          Edit
                        </button>
                        <button
                          onClick={() => setResettingPasswordUserId(u.id)}
                          className="btn btn-sm"
                          style={{ marginLeft: "0.25rem" }}
                        >
                          Reset Password
                        </button>
                        <button
                          onClick={() => setUserToDelete(u.id)}
                          disabled={u.id === user?.id}
                          className="btn btn-danger btn-sm"
                          style={{ marginLeft: "0.25rem", opacity: u.id === user?.id ? 0.5 : 1 }}
                        >
                          Delete
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {resettingPasswordUserId && (
          <Modal
            title="Reset Password"
            onConfirm={() => resetPassword(resettingPasswordUserId)}
            onCancel={() => { setResettingPasswordUserId(null); setNewPassword(""); }}
            confirmLabel="Reset Password"
          >
            <label>
              New Password
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                minLength={8}
                style={{ width: "100%", marginTop: "0.5rem" }}
              />
            </label>
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
      </div>
    </section>
  );
}
