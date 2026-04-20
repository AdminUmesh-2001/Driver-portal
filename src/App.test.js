import { render, screen } from '@testing-library/react';
import App from './App';

test('renders login screen first for a new session', () => {
  window.localStorage.clear();
  render(<App />);
  expect(screen.getByText(/nexora/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /forgot password/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
});
