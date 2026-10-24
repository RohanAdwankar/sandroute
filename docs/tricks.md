# The optimisation tricks the providers use

What each platform does to fit more tenants on a host, how we know, and whether it was tried here. "Observed" means seen from
inside a box (the Claude Code probe, the Muse post), "documented" means stated by the project or paper, and "inferred" is
mine. The full probe findings, including the disk/cgroup/egress ones that aren't capacity tricks, live in
`claude-code-box.md`. The tenant count that matters on this 7 GiB machine is in `capacity.md`.

## Do not back memory until it is used

Claude Code starts the kernel with `deferred_init=lazy` (observed). Of the 16 GiB, only 3.2 GiB is initialised at boot, so the
host does not have to commit the rest. Transparent hugepages are on `madvise` and there are no static hugepages (observed), so
a page is only a huge page when a program asks, and nothing is reserved up front. E2B restores a sandbox by serving memory lazily
on page faults through userfaultfd (documented in its README), so a resume fetches only what the guest touches. Lambda counts
slots by function size and oversubscribes memory and CPU: tested above 20x, run in production at up to 10x (the Firecracker
paper). Not tried here: lazy init and hugepage settings matter in big guests, and ours is 256 MiB. Our restored VMs map one
shared snapshot copy on write, which has the same effect for the same reason, and it was the largest single gain (128 tenants to 416).

## Give memory back as it is freed

Claude Code and Muse both run a balloon with free page reporting (observed). Claude Code's reports in 2 MiB chunks
(`page_reporting_order=9`), has the statistics queue on, and deflates on out-of-memory. Muse's idle box costs its 2 GB working
set, not its 8 GB. Tried here with order 3: it moves the kept design from 128 to about 150 tenants and does nothing for the released
ones, which run out of CPU first. Not tried: order 9, which means fewer, larger reports and so less CPU for the same memory back.

## Do not keep idle VMs, or make keeping them cheap

Claude Code kills an idle VM and keeps its disk, and the one wake seen was a cold boot (observed once; the kernel has VMGENID,
so it could be restoring from a snapshot sometimes). E2B pauses idle sandboxes by writing memory and disk diffs against the
template to object storage, and prefers resuming on the node that still has them cached (documented). Muse keeps a VM per user
up and cheap with the balloon, pre-boots a pool of them, and replaces a VM per rollout rather than rebooting it (the Muse post).
Tried here: snapshot on idle (416 tenants), kill and cold boot (ran out of memory at 78 resident VMs, because a cold booted VM costs
about 123 MiB against about 37 restored), and keeping everything up (128). Not tried: diff snapshots, which write only the pages that
changed since the template and match what E2B does. That is the most promising one for oxroute, whose limit shows 65 to 80% disk wait
and 15 to 18 GiB of snapshots on disk, and Firecracker supports them.

## Make a boot cheap

Claude Code boots straight into its agent with `rdinit=/process_api`, no init system, uses `nomodule`, `random.trust_cpu=1` so the
kernel does not wait for entropy, and a custom stripped kernel (observed). It still took 1.82 s to reach the agent in the probe.
Firecracker itself is a minimal device model: under 5 MB of overhead per VM and a boot under 125 ms on its own kernel (the paper).
E2B avoids booting by restoring ("a sandbox is a resumed snapshot", documented). Tried here: the shared snapshot restore, which takes
about 54 ms. Not tried: the boot arguments, since we restore instead of boot.

## Cap the fixed costs that grow with RAM

`swiotlb=noforce` skips a bounce buffer the kernel allocates in a guest with more than 4 GB, and `dhash_entries` and `ihash_entries`
cap two lookup tables that otherwise grow with memory (observed, my reading of what they do). They pay off in a 16 GiB guest and
very little in a 256 MiB one, so they are not worth testing here.

## Share what every tenant has in common

Claude Code mounts the harness, its environment runner and the skills as small read-only disks shared across tenants (observed).
Muse has a dm-verity tools image and a read-only root with a throwaway encrypted overlay for scratch (the Muse post). E2B puts a
copy-on-write overlay over a read-only template image (documented). Here the root is one read-only ext4 with a tmpfs overlay, shared by
every VM, and the snapshot is shared as well.

## Thin disks

Claude Code's root is a 256 GiB ext4 mounted with `discard`, and only about 30 GiB of it is usable: the filesystem reserves the rest
for a uid (`resv_strict`, `resuid=65534`), which is a way to sell a big disk and commit a small one (observed, my reading). Not
relevant to the memory and CPU limits here.

## Skipping mitigations that protect against attacks the kernel cannot suffer

Claude Code's `mitigations=auto,no_guest_host,no_guest_guest` is in mainline Linux: the attack vector controls added in 6.17 let a
kernel say which boundaries it needs protecting, and the kernel documentation's own example is `mitigations=auto,nosmt,no_guest_host,no_guest_guest`.
The four vectors are user to kernel, user to user, guest to host and guest to guest. The last two only do anything in a kernel that
runs VMs, and by default they are on when KVM is compiled in. Claude Code's guest kernel has KVM compiled in (and nested virtualization
switched off), so on `auto` it would pay for protections against VMs it never runs. The two settings turn those off and keep the other two,
which protect the guest's kernel and its agent from the code the agent runs. Protection against other tenants comes from the host kernel
running Firecracker, which keeps its own guest vectors on. This is the kernel documentation plus a reasonable reading of it, not something
Anthropic has said.

The same logic applies here with one limit. On the host, every vector stays on: the file-only tier runs tenant commands as host processes,
so user to kernel and user to user matter, and the VMs are hostile to each other, so the guest vectors matter too. Inside a guest, everything belongs to one tenant, so
a blanket `mitigations=off` would cost no other tenant anything. Our guest kernel is 6.1.128, which predates the vector syntax, so it is all or nothing.
Not tried here.

## Tried since: keep /tmp as files on the host

A guest that wrote to `/tmp` used to be kept as a 256 MiB memory snapshot, which cost most of the disk wait at oxroute's limit. Keeping scratch space as
host files like the workspace made those guests discardable and cut p99 at 576 tenants by about three times (see `capacity.md`). It is the cheap
version of what Claude Code does by keeping a disk and killing the VM.

## What this suggests trying next, in order

Now that disk wait is gone at 576, cpu is what is left, so diff snapshots matter less. Then `page_reporting_order=9`. Then THP and KSM (Claude Code's
kernel has `CONFIG_KSM=y`, but whether it is used is not shown), which could let identical pages across guests share memory.
