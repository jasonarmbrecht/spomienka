import { FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  Theme,
  Grid,
  Column,
  Form,
  Stack,
  TextInput,
  PasswordInput,
  Button,
  InlineNotification,
  Heading,
} from "@carbon/react";
import { useAuth } from "../pb/auth";

export function LoginPage() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      await login(email, password);
      nav("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  };

  return (
    <Theme theme="g100">
      <Grid
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Column sm={4} md={4} lg={6}>
          <Heading style={{ marginBottom: "2rem" }}>Frame Admin</Heading>
          {error && (
            <InlineNotification
              kind="error"
              title={error}
              lowContrast
              hideCloseButton
              style={{ marginBottom: "1rem" }}
            />
          )}
          <Form onSubmit={submit}>
            <Stack gap={6}>
              <TextInput
                id="email"
                labelText="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
              <PasswordInput
                id="password"
                labelText="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Button type="submit" kind="primary">
                Sign in
              </Button>
            </Stack>
          </Form>
        </Column>
      </Grid>
    </Theme>
  );
}
