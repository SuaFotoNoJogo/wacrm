import { ArrowRight, Server } from 'lucide-react'
import { Section, SectionHeader } from './section'
import { GithubIcon } from './github-icon'

const REPO_URL = 'https://github.com/ArnasDon/wacrm'
const HOSTINGER_URL = 'https://www.hostinger.com/vps-hosting'

export function OpenSource() {
  return (
    <Section id="self-host">
      <SectionHeader
        eyebrow="Open source"
        title="Fork it, brand it, host it"
        description="WaCRM is a template you can take and make your own. Grab the source on GitHub and self-host — we recommend Hostinger for a one-click Node.js VPS."
      />

      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5 md:grid-cols-2">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex flex-col rounded-xl border border-slate-800 bg-slate-900/40 p-6 transition-colors hover:border-slate-700 hover:bg-slate-900/70"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-slate-100">
            <GithubIcon className="h-5 w-5" />
          </div>
          <h3 className="mt-4 text-base font-semibold text-white">
            Source on GitHub
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
            Clone or fork the repository, tweak the code, ship your own build.
            MIT-style freedom with the full CRM underneath.
          </p>
          <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400 transition-colors group-hover:text-emerald-300">
            ArnasDon/wacrm
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </a>

        <a
          href={HOSTINGER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex flex-col rounded-xl border border-emerald-500/20 bg-slate-900/40 p-6 transition-colors hover:border-emerald-500/40 hover:bg-slate-900/70"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <Server className="h-5 w-5" />
          </div>
          <h3 className="mt-4 flex flex-wrap items-center gap-2 text-base font-semibold text-white">
            Deploy on Hostinger
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
              Recommended
            </span>
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
            Best fit for this template — spin up a Node.js VPS, point it at
            your forked repo, and WaCRM is live in a few minutes.
          </p>
          <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400 transition-colors group-hover:text-emerald-300">
            Get Hostinger VPS
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </a>
      </div>
    </Section>
  )
}
