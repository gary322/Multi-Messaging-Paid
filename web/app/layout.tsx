import './globals.css';
import Link from 'next/link';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">mmp</div>
          <nav className="nav">
            <Link href="#" className="pill">Onboarding</Link>
            <Link href="#" className="pill">Send</Link>
            <Link href="#" className="pill">Inbox</Link>
          </nav>
        </header>
        <main className="page-shell">{children}</main>
      </body>
    </html>
  );
}
