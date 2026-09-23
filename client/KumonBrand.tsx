// Wordmark: https://www.kumon.com/assets/images/kumon_logo.png
// Served locally so signing in does not contact a third-party asset host.
export default function KumonBrand({ className = '' }: { className?: string }) {
  return (
    <span className={`kumon-brand ${className}`}>
      <img src="/branding/kumon-logo.png" alt="Kumon" width="198" height="44" />
      <span>Center workspace</span>
    </span>
  );
}
