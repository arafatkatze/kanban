import { Button, Menu, MenuItem, Popover, PopoverInteractionKind, Tag, TextArea } from "@blueprintjs/core";
import { Classes as SelectClasses } from "@blueprintjs/select";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDebouncedEffect } from "@/utils/react-use";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { TaskImage } from "@/types";

const FILE_MENTION_LIMIT = 8;
const MENTION_QUERY_DEBOUNCE_MS = 120;
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface ActivePromptToken {
	kind: "mention";
	start: number;
	end: number;
	query: string;
}

interface PromptSuggestion {
	id: string;
	kind: "mention";
	text: string;
	insertText: string;
}

interface TaskPromptComposerProps {
	id?: string;
	value: string;
	onValueChange: (value: string) => void;
	images?: TaskImage[];
	onImagesChange?: (images: TaskImage[]) => void;
	onSubmit?: () => void;
	onSubmitAndStart?: () => void;
	placeholder?: string;
	disabled?: boolean;
	enabled?: boolean;
	autoFocus?: boolean;
	workspaceId?: string | null;
}

function detectActivePromptToken(value: string, cursorIndex: number): ActivePromptToken | null {
	const head = value.slice(0, cursorIndex);
	let tokenStart = head.length;
	while (tokenStart > 0) {
		const previous = head[tokenStart - 1];
		if (previous && /\s/.test(previous)) {
			break;
		}
		tokenStart -= 1;
	}
	const token = head.slice(tokenStart);
	if (!token.startsWith("@")) {
		return null;
	}
	return {
		kind: "mention",
		start: tokenStart,
		end: cursorIndex,
		query: token.slice(1),
	};
}

function applyTokenReplacement(
	value: string,
	token: ActivePromptToken,
	replacement: string,
): { value: string; cursor: number } {
	const before = value.slice(0, token.start);
	const after = value.slice(token.end);
	const shouldAppendSpace = after.length === 0 || !/^\s/.test(after);
	const spacer = shouldAppendSpace ? " " : "";
	const nextValue = `${before}${replacement}${spacer}${after}`;
	const nextCursor = before.length + replacement.length + spacer.length;
	return {
		value: nextValue,
		cursor: nextCursor,
	};
}

function fileToTaskImage(file: File): Promise<TaskImage | null> {
	return new Promise((resolve) => {
		if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
			resolve(null);
			return;
		}
		if (file.size > MAX_IMAGE_SIZE_BYTES) {
			resolve(null);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				resolve(null);
				return;
			}
			const base64 = result.split(",")[1];
			if (!base64) {
				resolve(null);
				return;
			}
			resolve({
				id: crypto.randomUUID().replaceAll("-", "").slice(0, 12),
				data: base64,
				mimeType: file.type,
				name: file.name || undefined,
			});
		};
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
}

async function extractImagesFromDataTransfer(dataTransfer: DataTransfer): Promise<TaskImage[]> {
	const images: TaskImage[] = [];
	for (const file of Array.from(dataTransfer.files)) {
		if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
			continue;
		}
		const image = await fileToTaskImage(file);
		if (image) {
			images.push(image);
		}
	}
	return images;
}

export function TaskPromptComposer({
	id,
	value,
	onValueChange,
	images = [],
	onImagesChange,
	onSubmit,
	onSubmitAndStart,
	placeholder,
	disabled,
	enabled = true,
	autoFocus = false,
	workspaceId = null,
}: TaskPromptComposerProps): ReactElement {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const popoverRef = useRef<InstanceType<typeof Popover> | null>(null);
	const menuRef = useRef<HTMLUListElement | null>(null);
	const suggestionItemRefs = useRef(new Map<string, HTMLLIElement>());
	const mentionSearchRequestIdRef = useRef(0);
	const [cursorIndex, setCursorIndex] = useState(0);
	const [mentionSuggestions, setMentionSuggestions] = useState<PromptSuggestion[]>([]);
	const [isMentionSearchLoading, setIsMentionSearchLoading] = useState(false);
	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
	const [isSuggestionPickerOpen, setIsSuggestionPickerOpen] = useState(true);

	const activeToken = useMemo(() => detectActivePromptToken(value, cursorIndex), [cursorIndex, value]);

	useEffect(() => {
		if (!enabled) {
			mentionSearchRequestIdRef.current += 1;
			setMentionSuggestions([]);
			setIsMentionSearchLoading(false);
			return;
		}
		if (!activeToken || activeToken.kind !== "mention") {
			mentionSearchRequestIdRef.current += 1;
			setMentionSuggestions([]);
			setIsMentionSearchLoading(false);
			return;
		}
		mentionSearchRequestIdRef.current += 1;
	}, [activeToken, workspaceId]);

	useDebouncedEffect(
		() => {
			if (!enabled) {
				return;
			}
			if (!activeToken || activeToken.kind !== "mention") {
				return;
			}
			const requestId = mentionSearchRequestIdRef.current;
			setIsMentionSearchLoading(true);
			void (async () => {
				try {
					if (!workspaceId) {
						throw new Error("No workspace selected.");
					}
					const trpcClient = getRuntimeTrpcClient(workspaceId);
					const payload = await trpcClient.workspace.searchFiles.query({
						query: activeToken.query,
						limit: FILE_MENTION_LIMIT,
					});
					if (requestId !== mentionSearchRequestIdRef.current) {
						return;
					}
					setMentionSuggestions(
						Array.isArray(payload.files)
							? payload.files.map((file) => ({
									id: file.path,
									kind: "mention",
									text: file.path,
									insertText: `@${file.path}`,
								}))
							: [],
					);
				} catch {
					if (requestId === mentionSearchRequestIdRef.current) {
						setMentionSuggestions([]);
					}
				} finally {
					if (requestId === mentionSearchRequestIdRef.current) {
						setIsMentionSearchLoading(false);
					}
				}
			})();
		},
		MENTION_QUERY_DEBOUNCE_MS,
		[activeToken, enabled, workspaceId],
	);

	const suggestions = useMemo(() => {
		return enabled && activeToken ? mentionSuggestions : ([] as PromptSuggestion[]);
	}, [activeToken, enabled, mentionSuggestions]);

	useEffect(() => {
		setSelectedSuggestionIndex(0);
		setIsSuggestionPickerOpen(true);
	}, [activeToken?.kind, activeToken?.query, activeToken?.start]);

	useEffect(() => {
		if (!autoFocus) {
			return;
		}
		window.requestAnimationFrame(() => {
			if (!textareaRef.current) {
				return;
			}
			const cursor = textareaRef.current.value.length;
			textareaRef.current.focus();
			textareaRef.current.setSelectionRange(cursor, cursor);
			setCursorIndex(cursor);
		});
	}, [autoFocus]);

	const applySuggestion = useCallback(
		(suggestion: PromptSuggestion) => {
			if (!activeToken) {
				return;
			}
			const next = applyTokenReplacement(value, activeToken, suggestion.insertText);
			onValueChange(next.value);
			window.requestAnimationFrame(() => {
				if (!textareaRef.current) {
					return;
				}
				textareaRef.current.focus();
				textareaRef.current.setSelectionRange(next.cursor, next.cursor);
				setCursorIndex(next.cursor);
			});
		},
		[activeToken, onValueChange, value],
	);

	const setSuggestionItemRef = useCallback((itemKey: string, node: HTMLLIElement | null) => {
		if (node) {
			suggestionItemRefs.current.set(itemKey, node);
			return;
		}
		suggestionItemRefs.current.delete(itemKey);
	}, []);

	const handleTextareaKeyDown = useCallback(
		(event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.shiftKey) {
					if (onSubmitAndStart) {
						onSubmitAndStart();
						return;
					}
				}
				onSubmit?.();
				return;
			}

			const canShowSuggestions = isSuggestionPickerOpen && suggestions.length > 0;
			if (canShowSuggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setSelectedSuggestionIndex((index) => {
					const nextIndex = index + direction;
					if (nextIndex < 0) {
						return suggestions.length - 1;
					}
					if (nextIndex >= suggestions.length) {
						return 0;
					}
					return nextIndex;
				});
				return;
			}

			if (canShowSuggestions && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
				event.preventDefault();
				const selectedSuggestion = suggestions[selectedSuggestionIndex] ?? suggestions[0];
				if (selectedSuggestion) {
					applySuggestion(selectedSuggestion);
				}
				return;
			}

			if (event.key === "Escape" && canShowSuggestions) {
				event.preventDefault();
				setIsSuggestionPickerOpen(false);
			}
		},
		[applySuggestion, isSuggestionPickerOpen, onSubmit, onSubmitAndStart, selectedSuggestionIndex, suggestions],
	);

	const [isDragOver, setIsDragOver] = useState(false);

	const handlePaste = useCallback(
		(event: ClipboardEvent<HTMLTextAreaElement>) => {
			if (!onImagesChange || !event.clipboardData) {
				return;
			}
			const imageFiles = Array.from(event.clipboardData.files).filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type));
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void (async () => {
				const newImages = await extractImagesFromDataTransfer(event.clipboardData);
				if (newImages.length > 0) {
					onImagesChange([...images, ...newImages]);
				}
			})();
		},
		[images, onImagesChange],
	);

	const handleDrop = useCallback(
		(event: DragEvent<HTMLTextAreaElement>) => {
			setIsDragOver(false);
			if (!onImagesChange || !event.dataTransfer) {
				return;
			}
			const imageFiles = Array.from(event.dataTransfer.files).filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type));
			if (imageFiles.length === 0) {
				return;
			}
			event.preventDefault();
			void (async () => {
				const newImages = await extractImagesFromDataTransfer(event.dataTransfer);
				if (newImages.length > 0) {
					onImagesChange([...images, ...newImages]);
				}
			})();
		},
		[images, onImagesChange],
	);

	const handleDragOver = useCallback(
		(event: DragEvent<HTMLTextAreaElement>) => {
			if (!onImagesChange) {
				return;
			}
			const hasImages = Array.from(event.dataTransfer.types).includes("Files");
			if (hasImages) {
				event.preventDefault();
				setIsDragOver(true);
			}
		},
		[onImagesChange],
	);

	const handleDragLeave = useCallback(() => {
		setIsDragOver(false);
	}, []);

	const handleRemoveImage = useCallback(
		(imageId: string) => {
			onImagesChange?.(images.filter((img) => img.id !== imageId));
		},
		[images, onImagesChange],
	);

	const showMentionLoading = Boolean(enabled && activeToken && isMentionSearchLoading);
	const showSuggestions = Boolean(
		enabled && isSuggestionPickerOpen && activeToken && (showMentionLoading || suggestions.length > 0),
	);

	useEffect(() => {
		if (!showSuggestions) {
			return;
		}
		window.requestAnimationFrame(() => {
			void popoverRef.current?.reposition();
		});
	}, [activeToken?.query, showMentionLoading, showSuggestions, suggestions.length]);

	useEffect(() => {
		if (!showSuggestions) {
			return;
		}
		const activeSuggestion = suggestions[selectedSuggestionIndex];
		if (!activeSuggestion) {
			return;
		}
		const activeKey = `${activeSuggestion.kind}:${activeSuggestion.id}`;
		const activeElement = suggestionItemRefs.current.get(activeKey);
		const menuElement = menuRef.current;
		if (!activeElement || !menuElement) {
			return;
		}
		const activeTop = activeElement.offsetTop;
		const activeBottom = activeTop + activeElement.offsetHeight;
		const viewportTop = menuElement.scrollTop;
		const viewportBottom = viewportTop + menuElement.clientHeight;
		if (activeBottom > viewportBottom) {
			menuElement.scrollTop = activeBottom - menuElement.clientHeight;
			return;
		}
		if (activeTop < viewportTop) {
			menuElement.scrollTop = activeTop;
		}
	}, [selectedSuggestionIndex, showSuggestions, suggestions]);

	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const handleAttachClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleFileInputChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			if (!onImagesChange || !event.target.files) {
				return;
			}
			void (async () => {
				const newImages: TaskImage[] = [];
				for (const file of Array.from(event.target.files ?? [])) {
					const image = await fileToTaskImage(file);
					if (image) {
						newImages.push(image);
					}
				}
				if (newImages.length > 0) {
					onImagesChange([...images, ...newImages]);
				}
				event.target.value = "";
			})();
		},
		[images, onImagesChange],
	);

	return (
		<div>
			<Popover
				autoFocus={false}
				enforceFocus={false}
				fill
				interactionKind={PopoverInteractionKind.CLICK_TARGET_ONLY}
				isOpen={showSuggestions}
				matchTargetWidth
				minimal
				modifiers={{ flip: { enabled: false } }}
				onInteraction={(nextOpenState) => {
					if (!nextOpenState) {
						setIsSuggestionPickerOpen(false);
					}
				}}
				onOpened={() => {
					void popoverRef.current?.reposition();
				}}
				placement="bottom-start"
				popoverClassName={SelectClasses.SUGGEST_POPOVER}
				content={
					showMentionLoading ? (
						<Menu>
							<MenuItem disabled text="Loading files..." roleStructure="listoption" />
						</Menu>
					) : (
						<Menu ulRef={menuRef} style={{ overflowX: "hidden", overflowY: "auto" }}>
							{suggestions.map((suggestion, index) => {
								const suggestionKey = `${suggestion.kind}:${suggestion.id}`;
								return (
									<MenuItem
										key={suggestionKey}
										ref={(node) => setSuggestionItemRef(suggestionKey, node)}
										active={index === selectedSuggestionIndex}
										roleStructure="listoption"
										style={{ paddingLeft: 6, paddingRight: 6 }}
										text={
											<span
												style={{
													display: "block",
													fontSize: "var(--bp-typography-size-body-small)",
													lineHeight: 1.15,
													maxWidth: "100%",
													overflowWrap: "anywhere",
													wordBreak: "break-word",
													whiteSpace: "normal",
												}}
											>
												{suggestion.text}
											</span>
										}
										onMouseDown={(event) => {
											event.preventDefault();
											applySuggestion(suggestion);
										}}
										onMouseEnter={() => setSelectedSuggestionIndex(index)}
									/>
								);
							})}
						</Menu>
					)
				}
				ref={popoverRef}
			>
				<TextArea
					id={id}
					inputRef={textareaRef}
					value={value}
					onChange={(event) => {
						onValueChange(event.target.value);
						setCursorIndex(event.target.selectionStart ?? event.target.value.length);
					}}
					onKeyDown={handleTextareaKeyDown}
					onClick={(event) =>
						setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
					}
					onKeyUp={(event) =>
						setCursorIndex(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
					}
					onPaste={handlePaste}
					onDrop={handleDrop}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					placeholder={placeholder ?? "Describe the task..."}
					disabled={disabled}
					autoFocus={autoFocus}
					fill
					style={{
						minHeight: 80,
						resize: "vertical",
						...(isDragOver
							? { outline: "2px dashed var(--bp-intent-primary-rest)", outlineOffset: -2 }
							: {}),
					}}
				/>
			</Popover>

			{images.length > 0 && (
				<div
					style={{
						display: "flex",
						flexWrap: "wrap",
						gap: 6,
						marginTop: 6,
					}}
				>
					{images.map((image) => (
						<Tag
							key={image.id}
							icon="media"
							onRemove={() => handleRemoveImage(image.id)}
							intent="none"
							round
						>
							<span
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: 4,
								}}
							>
								<img
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={image.name ?? "attached image"}
									style={{
										width: 20,
										height: 20,
										objectFit: "cover",
										borderRadius: 2,
									}}
								/>
								<span style={{ fontSize: "var(--bp-typography-size-body-small)" }}>
									{image.name ?? "Image"}
								</span>
							</span>
						</Tag>
					))}
				</div>
			)}

			{onImagesChange && (
				<>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/png,image/jpeg,image/gif,image/webp"
						multiple
						style={{ display: "none" }}
						onChange={handleFileInputChange}
					/>
					<div style={{ marginTop: images.length > 0 ? 4 : 6 }}>
						<Button
							icon="paperclip"
							text="Attach image"
							variant="minimal"
							size="small"
							onClick={handleAttachClick}
							disabled={disabled}
						/>
					</div>
				</>
			)}
		</div>
	);
}
