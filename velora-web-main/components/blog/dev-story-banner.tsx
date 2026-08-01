import { Lightbulb } from "lucide-react";

export function DevStoryBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`rounded-lg border border-primary/20 bg-primary/5 ${
        compact ? "p-4 mb-8" : "p-6 mb-12"
      }`}
    >
      <div className="flex items-start gap-3">
        <Lightbulb className="w-5 h-5 text-primary shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-foreground mb-1">Dev story — work in progress</p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            These posts are engineering notes from building Velora. They capture what we believed
            at the time — some lessons aged well, some did not. Treat them as a lab notebook, not
            official docs. Corrections and better ideas are welcome.
          </p>
        </div>
      </div>
    </div>
  );
}