import { FormEvent, useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";

type UserRecord = {
  id: string;
  email: string;
  name?: string;
  role?: string;
  created: string;
};

// Email validation regex
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Validate password strength
 */
function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  // Check for at least one letter and one number
  if (!/[a-zA-Z]/.test(password)) {
    return "Password must contain at least one letter";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number";
  }
  return null;
}

export function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [userToDelete, setUserToDelete] = useState<string | null>(null);
  const [resettingPasswordUserId, setResettingPasswordUserId] = useState<string | null>(null);

  // Form state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [creating, setCreating] = useState(false);

  // Edit form state
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
      });
      setUsers(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const createUser = async (e: FormEvent) => {
    e.preventDefault();
    
    // Validate required fields
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required");
      return;
    }
    
    // Validate email format
    if (!isValidEmail(email)) {
      setError("Please enter a valid email address");
      return;
    }
    
    // Validate password strength
    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setCreating(true);
    setError(null);
    setMessage(null);

    try {
      await pb.collection("users").create({
        email: email.trim(),
        password,
        passwordConfirm: password,
        name: name.trim() || undefined,
        role,
      });

      setMessage(`User "${email}" created successfully`);
      setEmail("");
      setPassword("");
      setName("");
      setRole("user");
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
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
      const updateData: Record<string, unknown> = {
        email: editEmail.trim(),
        name: editName.trim() || undefined,
        role: editRole,
      };

      await pb.collection("users").update(userId, updateData);
      await loadUsers();
      setEditingUserId(null);
      setMessage("User updated successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update user");
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
      setMessage("Password reset successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    }
  };

  const deleteUser = async (userId: string) => {
    // Prevent self-deletion
    if (userId === user?.id) {
      setError("You cannot delete your own account");
      setUserToDelete(null);
      return;
    }

    // Check if this is the last admin
    const adminCount = users.filter((u) => u.role === "admin").length;
    const userToDeleteRecord = users.find((u) => u.id === userId);
    if (userToDeleteRecord?.role === "admin" && adminCount === 1) {
      setError("Cannot delete the last admin user");
      setUserToDelete(null);
      return;
    }

    setError(null);
    try {
      await pb.collection("users").delete(userId);
      await loadUsers();
      setUserToDelete(null);
      setMessage("User deleted successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  return (
    <section>
      <h1>Users</h1>

      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}

      <div className="create-user">
        <h2>Create New User</h2>
        <form onSubmit={createUser}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              minLength={8}
            />
          </label>
          <label>
            Display Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
            />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button type="submit" disabled={creating}>
            {creating ? "Creating..." : "Create User"}
          </button>
        </form>
      </div>

      <div className="user-list">
        <h2>Existing Users</h2>
        {loading && <p>Loading users...</p>}
        {!loading && users.length === 0 && <p>No users found.</p>}
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
                        <button onClick={() => saveEditUser(u.id)} style={{ padding: "0.25rem 0.5rem", fontSize: "0.8125rem" }}>
                          Save
                        </button>
                        <button onClick={cancelEditUser} style={{ padding: "0.25rem 0.5rem", fontSize: "0.8125rem", marginLeft: "0.25rem" }}>
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
                        <button
                          onClick={() => startEditUser(u)}
                          style={{ padding: "0.25rem 0.5rem", fontSize: "0.8125rem" }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setResettingPasswordUserId(u.id)}
                          style={{ padding: "0.25rem 0.5rem", fontSize: "0.8125rem", marginLeft: "0.25rem" }}
                        >
                          Reset Password
                        </button>
                        <button
                          onClick={() => setUserToDelete(u.id)}
                          disabled={u.id === user?.id}
                          style={{
                            padding: "0.25rem 0.5rem",
                            fontSize: "0.8125rem",
                            marginLeft: "0.25rem",
                            background: "var(--color-error)",
                            opacity: u.id === user?.id ? 0.5 : 1,
                          }}
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
          <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}>
            <div style={{
              background: "var(--color-surface)",
              padding: "1.5rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              maxWidth: "400px",
            }}>
              <h3 style={{ marginBottom: "1rem" }}>Reset Password</h3>
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
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", marginTop: "1rem" }}>
                <button onClick={() => { setResettingPasswordUserId(null); setNewPassword(""); }}>
                  Cancel
                </button>
                <button onClick={() => resetPassword(resettingPasswordUserId)}>
                  Reset Password
                </button>
              </div>
            </div>
          </div>
        )}

        {userToDelete && (
          <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}>
            <div style={{
              background: "var(--color-surface)",
              padding: "1.5rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--color-border)",
              maxWidth: "400px",
            }}>
              <h3 style={{ marginBottom: "1rem" }}>Confirm Deletion</h3>
              <p style={{ marginBottom: "1rem" }}>
                Are you sure you want to delete this user? This action cannot be undone.
              </p>
              <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                <button onClick={() => setUserToDelete(null)}>Cancel</button>
                <button
                  onClick={() => deleteUser(userToDelete)}
                  style={{ background: "var(--color-error)" }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

