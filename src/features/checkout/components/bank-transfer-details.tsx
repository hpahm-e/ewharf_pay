import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import type { CheckoutOrder } from "../checkout-model";
import { CopyIconButton } from "./checkout-display";

type Bank = NonNullable<CheckoutOrder["bank"]>;

/** Bank transfer instructions with a VietQR code for SePay receiving methods. */
export function BankTransferDetails({
	bank,
	accountNumber,
	amount,
	onCopyText,
}: {
	bank: Bank;
	accountNumber: string;
	amount: string;
	onCopyText: (
		value: string,
	) => boolean | undefined | Promise<boolean | undefined>;
}) {
	const qrUrl = new URL("https://vietqr.app/img");
	qrUrl.searchParams.set("acc", accountNumber);
	qrUrl.searchParams.set("bank", bank.name);
	qrUrl.searchParams.set("amount", amount);
	qrUrl.searchParams.set("des", bank.transfer_content);
	qrUrl.searchParams.set("template", "qronly");
	const formattedAmount = `${new Intl.NumberFormat(getLocale(), {
		maximumFractionDigits: 0,
	}).format(Number(amount))} VND`;
	return (
		<>
			<div className="mb-4 flex justify-center">
				<div className="rounded-xl border bg-white p-3 shadow-md">
					<img
						alt={m.checkout_bank_qr_alt()}
						className="size-44"
						height={176}
						referrerPolicy="no-referrer"
						src={qrUrl.toString()}
						width={176}
					/>
				</div>
			</div>
			<div className="-mx-5 w-[calc(100%+2.5rem)] border-border/50 border-t">
				<BankRow label={m.checkout_bank_name()} value={bank.name} />
				<BankRow
					label={m.checkout_bank_account()}
					onCopy={() => onCopyText(accountNumber)}
					value={accountNumber}
				/>
				{bank.account_name ? (
					<BankRow label={m.checkout_bank_holder()} value={bank.account_name} />
				) : null}
				<BankRow
					label={m.checkout_bank_amount()}
					onCopy={() => onCopyText(amount)}
					value={formattedAmount}
				/>
				<BankRow
					hint={m.checkout_bank_content_help()}
					label={m.checkout_bank_content()}
					onCopy={() => onCopyText(bank.transfer_content)}
					value={bank.transfer_content}
				/>
			</div>
		</>
	);
}

function BankRow({
	hint,
	label,
	onCopy,
	value,
}: {
	hint?: string;
	label: string;
	onCopy?: () => boolean | undefined | Promise<boolean | undefined>;
	value: string;
}) {
	return (
		<div className="flex items-start gap-3 border-border/50 border-b px-5 py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<p className="mb-0.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
					{label}
				</p>
				<p className="break-all font-medium text-card-foreground text-sm leading-relaxed">
					{value}
				</p>
				{hint ? (
					<p className="mt-0.5 text-muted-foreground text-xs">{hint}</p>
				) : null}
			</div>
			{onCopy ? <CopyIconButton className="mt-0.5" onClick={onCopy} /> : null}
		</div>
	);
}
