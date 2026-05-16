// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// Imports all modules and assigns onclick-referenced functions to window
// ═══════════════════════════════════════════════════════════════════

import { S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, INGREDIENT_TYPE_TO_GROUP, ALL_CATEGORIES, PRICE_LEVELS, STORAGE_CATEGORIES, rebuildStorageCategories, getStorageConfigForLoc, getStorageColor, DEFAULT_STORAGE_CONFIG, NAV_SCREENS, ACCOMPANIMENTS, setGlobalLocation, restoreGlobalLocation } from './state';
import { handleGoogleLogin, devLogin, doLogout, initGoogleSignIn, checkSession, showApp, showLocationChooser, selectLocation } from './auth';
import { newId, apiGet, apiPost, setSaveState, takeSnapshot, computePatch, patchIsEmpty, scheduleSave, doSave, retrySave, loadData, showDataError, hideDataError, retryLoad, loadIngredientDb, loadStorageConfig, saveStorageConfig, loadGuestHistory, loadGuestsNextWeeks, scheduleNextWeeksSave, toast, toastError, connectLiveSync, disconnectLiveSync, applyRemotePatch, todayIso, loadPrepChecklist, schedulePrepSave, saveState, ingredientDbLoaded, ingredientDbError, setOnBatchesChanged, setFlushUndo, setLoadIngredientDbFull, setOnRemotePatchApplied } from './utils';
import { isBatchCooked, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, rebuildPlanner, renderDishListSplit, sortByCookDate, getGuests, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, diffStr, storageBadge, storageBadgeClass, openServedDialog, openServedDialogForLoc, confirmArchiveWholeBatch, pendingRatings, ratingButtons, setRating, archiveDish, typeBadge, typeBadgeClass, TYPES, cycleType, toggleOrder, chipClass, getToday, dateToStr, strToDate, setRefreshInventoryModal } from './core';
import { parseCSV, categorizeUploadedFiles, predictGuests, buildFlowDistribution, averageLayers, detectFormat, parseSemicolonCSV, mergeAggregated, categorizeProfitCenterData, categorizeLightspeedData, parseLightspeedMinuteOfDay, parseLightspeedHour, parseLightspeedDate, categorizeTebiData, extractMinuteOfDayFromTebiRow, extractHourFromTebiRow, extractDeviceId, winsorize, percentile, getDayOfWeek, getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav, emptyAggregated, AGG_MEALS } from './predictions';
import { showScreen, renderDashboard, setGuestFlowMeal, drawGuestFlowChart, buildGuestFlowData, gaussian, loadDayTodos, saveDayTodos, toggleHeatItem, startCookConfirm, cookConfirmAt, addCustomTodo, toggleCustomTodo, deleteCustomTodo, toggleTeamTodos, renderTeamTodos, togglePrepItem, renderDashboardContent, renderPrepChecklist, navTo, getMenuDishes, calcLitersForService, getVegIngredients, setDishStarch, starchSummaryHtml, isChoppableIngredient, isDishAtLocation, getCookDateDishes, getIngredientCategoryCache, _ingredientCategoryCache, CHOPPABLE_CATEGORIES, PANTRY_KEYWORDS, _guestFlowMeal, setDashMeal, toggleDashChipExpand, openStocktakeModal, dashStocktakeEnterArea, dashStocktakeBack, dashStocktakeUpdate, dashStocktakeSave, getMenuDishesForMeal } from './dashboard';
import { renderGuests, changeGuestDay, getGuestForDay, renderUploadSection, setupUploadHandlers, handleFiles, saveUploadedHistory, applyPredictions, updateGuests, updateGuestsNextWeek, restoreFocusAfterRender, sumCatDays, formatDateShort, _pendingUpload, _guestsDayOffset } from './guests';
import { renderWeekPlan, setPlannerSubTab, renderPlannerSubTab, rerenderCurrentView, changePlannerDay, renderLocationPlan, getPoolBatches, toggleTypeBatchPool, renderTypeBatchPool, toggleShowAllBatches, renderShowAllBatches, batchDragStart, batchDragEnd, slotDragOver, slotDragLeave, slotDrop, assignFamilyToSlot, renderTransportView, addTransportItem, deliverTransportItem, markSelectedArrived, markShipmentArrived, cancelShipment, removeDishFromSlot, removeFamilyFromSlot, toggleTypeCollapse, copyDayToOther, copySlotToOther, openAddDishTyped, openAddDish, renderAddModal, updateAddModal, switchAddModalTab, switchAddModalLoc, searchAddModal, confirmAddDish, addRecipeToSlot, addPlaceholderDish, openReplaceBatch, renderReplaceModal, switchReplaceTab, searchReplaceModal, confirmReplaceBatch, replaceWithRecipe, replaceWithV2Recipe, getInventoryState, getInventoryButton, openInventory, setInvMode, updateLocScopedQty, cycleInventoryStorageAt, cycleEntryStorageAt, updatePowerEntryQty, updateInventoryStock, cycleInventoryStorage, openServedFromInventory, finishInventory, refreshInventoryModalIfOpen, _plannerDayOffset } from './planner';
import { renderDishesOverview, dishSortBy, renderBatchTile, toggleBatchExpand, toggleBreakdown, showNoteInput, cleanCateringRefs, deleteBatch, inlineEdit, inlineRemoveAllergen, inlineAddAllergenStart, inlineAddAllergenConfirm, getCookDayOptions, isDishCooked, isCookDayToday, isDishStale, daysSinceCooked, batchCookLabel, tileEditCookDate, getCookCellHtml, cookDateToISO, isoToCookDate, setCookDay, setCookDateDirect, confirmCooked, confirmCookedAt, setFilter, toggleSelect, calcRequiredForLoc, openNewDish, searchNewDishModal, pickRecipeForNewBatch, saveBatchFromRecipe, openNewDishScratch, saveNewDish, openEditDish, setEditMode, openInventoryEditor, setInvAction, cancelInvAction, confirmInvAction, openSendModal, rerenderSendModal, confirmSendShipment, openTransferModal, confirmTransferStock, updateInventoryField, removeInventoryEntry, addInventoryEntry, cancelShipmentFromEdit, setCookMode, addExtraAllergen, removeExtraAllergen, refreshAllergenTags, saveEditDish, deleteDish, dishSort, renderDishGroups, logisticsRowClass } from './dishes';
import { renderCaterings, openNewCatering, saveNewCatering, openEditCatering, renderCateringDishList, openAddCateringDish, renderCateringDishPicker, addCateringDishFromPlanner, removeCateringDish, saveEditCatering, deleteCatering, searchCateringDishes, cateringDragOver, cateringDragLeave, cateringDrop, removeCateringDishFromCard } from './caterings';
import { renderRecipeIndex, updateRecipeResults, updateRiSearch, riSortBy, openAddRecipe, setRiMode, extractSheetId, fetchAndAddRecipe, bulkAddRecipes, openEditRecipe, saveEditRecipe, deleteRecipeIndex, addDishFromRecipe, addDishFromV2Recipe, deleteV2Recipe, riSearch, riTypeFilter, riSort, parseCost, costColor, avgRating } from './recipes';
import { openRecipeEditor, openRecipeDetail, reUpdateField, rePhotoSelected, reRemovePhoto, reAddIngredient, reRemoveIngredient, reMoveIngredient, reToggleFlexible, reUpdateIngredient, reIngredientSearch, reSelectIngredient, reHideSuggestions, reAddPrepStep, reRemovePrepStep, reMovePrepStep, reUpdatePrepStep, rePrepGhostFocus, reAddExtraAllergen, reRemoveExtraAllergen, reSaveRecipe, rePrintRecipe, reVersionRecipe, openBatchRecipe, openResolveFlexible, openPostCookRecording, brToggleFullscreen, brUpdateTargetLiters, brUpdateTargetPortions, detailUpdateLiters, detailUpdatePortions, detailResetScale, detailToggleCooked, brIngSearch, brPickIng, brUnresolve, brUpdateAmount, brRemoveIng, brRestoreIng, brAddIngSearch, brAddIng, brUpdateNotes, brToggleDeduct, brClose, brSave, reToggleAiMode } from './recipe-editor';
import { aiRecipeSend, aiRecipeKey, aiRecipeReset } from './recipe-ai-chat';
import { renderOrders, switchOrdersTab, renderStandardInventoryTab, renderDishesTab, renderBatchIngredientTable, renderCombinedOrderTab, toggleBatchIngredient, toggleAllBatchIngredients, toggleCombinedIncludeDishes, copyOrderCodes, copyDishOrderCodes, copySiOrderCodes, copyCombinedOrderCodes, checkHanosStatus, isHanosEnabled, collectHanosItems, hanosAddSingle, hanosConfirmBulk, collectHanosBatchItems, hanosConfirmBulkBatches, showHanosConfirmModal, hanosExecuteFromModal, saveGramsPerPiece, toggleOrderSection, persistIngredientStock, updateOrderStockInput, updateCombinedOrderStock, updateOrderStock, startStocktake, renderStocktakeAreaPicker, enterStocktakeArea, renderStocktakeArea, updateStocktakeToOrder, saveStocktakeArea, exitStocktake, buildCombinedOrderData, getIngredientsForArea, toBaseUnit, normalizeSupplier, formatAmount, lookupIngredient, getDbStockTotal, hasDbStockEntry, formatStorageLoc, getStorageCategory, renderStorageBadge, calcOrderUnits, getStandardInventoryItems, updateSiSearch, hideSiSuggestions, addToStandardInventory, removeSiItem, updateSiTarget, updateSiStock, resetBatchToggles } from './orders';
import { renderIngredientDbTab, loadIngredientDbFull, updateIngredientSearch, getFilteredIngredients, renderTypePills, renderPriceLevel, renderInlineStock, saveInlineStock, renderStockBadges, renderIngredientEditRow, showInlineCategoryEdit, saveInlineCategory, updateStorageLocOpts, updateEditCategoryOptions, saveIngredientEdit, toggleIngredientActive, deleteIngredient, openIngredientModal, saveIngredientFromModal, hanosLookupProduct, openAddIngredientModal, saveNewIngredient, openStoragePopover, updatePopStorageLoc, saveStorageFromPopover, handleSupplierUpload, renderSupplierImportPanel, applySupplierUpdate, openStorageLocationsModal, renderStorageModal, ingredientMatchesTypeFilter, getCategoriesForTypeFilter, dropStorageArea, updateStorageColor, addStorageCategory, removeStorageCategory, addStorageSpot, removeStorageSpot, storageModalLoc, storageModalDragIdx, setIngredientDbEditId } from './ingredient-db';
import { renderFinance, loadFinanceData, loadFinanceProducts, checkSyncStatus, triggerSync, renderProductBreakdown, setFinanceProductFilter, cancelSync, changeFinanceWeek, getFinanceMonday, fmtDate, fmtDateShort, fmtEuro, fmtEuroFull, SERVICE_PERIODS, FINANCE_LOCATIONS } from './finance';
import { openFeedback, selectFeedbackType, submitFeedback, showFeedbackFab, feedbackTypes, feedbackSelectedType } from './feedback';
import { renderFeedbackAdmin, setFeedbackFilter, copyFeedbackForClaude, formatFeedbackDate, feedbackData, feedbackFilter, toggleFeedbackItemProcessed, toggleFeedbackProcessed } from './feedback-admin';
import { TUTORIALS, startTutorial, tutNext, tutPrev, tutSkip } from './tutorial';
import { toggleTheme, showModal, closeModal, esc, buildNav, initApp, bootstrap, switchGlobalLocation } from './init';
import { initTelemetry, trackScreenView, trackEvent, trackError } from './telemetry';
import { executeUndo, flushUndo } from './undo';
import { fixMyMenu, openKitchenEquipmentModal, keqAddPotFromInput, keqRemovePot, keqUpdateBurners, keqSave, fixMenuGoto, fixMenuAction } from './menu-fixer';
import { setTransportMode, confirmTransportPlan, confirmCentraalArrivals } from './transport-card';
import { renderCompetencies, openCompLogModal, selectCompTeacher, submitCompLog, openCompAddPerson, submitCompAddPerson, setCompStationFilter, openCompPerson, compBackToGrid, openCompChunk, openCompAdmin, compSyncNotion, compRenamePerson, submitCompRename, compTogglePersonActive, compDeleteEvent, confirmCompDeleteEvent } from './competencies';

// ═══════════════════════════════════════════════════════════════════
// Wire up cross-module callbacks (avoids circular imports)
setOnBatchesChanged(resetBatchToggles);
setFlushUndo(flushUndo);
setLoadIngredientDbFull(loadIngredientDbFull);
setOnRemotePatchApplied(refreshInventoryModalIfOpen);
setRefreshInventoryModal(refreshInventoryModalIfOpen);

// Assign all functions called from onclick="" to window
// ═══════════════════════════════════════════════════════════════════
Object.assign(window, {
  // state
  S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, INGREDIENT_TYPE_TO_GROUP, ALL_CATEGORIES, PRICE_LEVELS, STORAGE_CATEGORIES, rebuildStorageCategories, getStorageConfigForLoc, getStorageColor, DEFAULT_STORAGE_CONFIG, NAV_SCREENS, ACCOMPANIMENTS, setGlobalLocation, restoreGlobalLocation,

  // auth
  handleGoogleLogin, devLogin, doLogout, initGoogleSignIn, checkSession, showApp, showLocationChooser, selectLocation,

  // utils
  newId, apiGet, apiPost, setSaveState, takeSnapshot, computePatch, patchIsEmpty, scheduleSave, doSave, retrySave, loadData, showDataError, hideDataError, retryLoad, loadIngredientDb, loadStorageConfig, saveStorageConfig, loadGuestHistory, loadGuestsNextWeeks, scheduleNextWeeksSave, toast, toastError, connectLiveSync, disconnectLiveSync, applyRemotePatch, todayIso, loadPrepChecklist, schedulePrepSave,

  // undo
  executeUndo,

  // core
  isBatchCooked, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, rebuildPlanner, renderDishListSplit, sortByCookDate, getGuests, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, diffStr, storageBadge, storageBadgeClass, openServedDialog, openServedDialogForLoc, confirmArchiveWholeBatch, ratingButtons, setRating, archiveDish, typeBadge, typeBadgeClass, TYPES, cycleType, toggleOrder, chipClass, getToday, dateToStr, strToDate,

  // predictions
  parseCSV, categorizeUploadedFiles, predictGuests, buildFlowDistribution, averageLayers, detectFormat, parseSemicolonCSV, mergeAggregated, getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav,

  // dashboard
  showScreen, renderDashboard, setGuestFlowMeal, drawGuestFlowChart, buildGuestFlowData, loadDayTodos, saveDayTodos, toggleHeatItem, startCookConfirm, cookConfirmAt, addCustomTodo, toggleCustomTodo, deleteCustomTodo, toggleTeamTodos, renderTeamTodos, togglePrepItem, renderDashboardContent, renderPrepChecklist, navTo, getMenuDishes, calcLitersForService, getVegIngredients, setDishStarch, starchSummaryHtml, isChoppableIngredient, isDishAtLocation, getCookDateDishes, setDashMeal, toggleDashChipExpand, openStocktakeModal, dashStocktakeEnterArea, dashStocktakeBack, dashStocktakeUpdate, dashStocktakeSave, getMenuDishesForMeal,

  // guests
  renderGuests, changeGuestDay, getGuestForDay, renderUploadSection, setupUploadHandlers, handleFiles, saveUploadedHistory, applyPredictions, updateGuests, updateGuestsNextWeek, restoreFocusAfterRender,

  // planner
  renderWeekPlan, setPlannerSubTab, renderPlannerSubTab, rerenderCurrentView, changePlannerDay, renderLocationPlan, getPoolBatches, toggleTypeBatchPool, renderTypeBatchPool, toggleShowAllBatches, renderShowAllBatches, batchDragStart, batchDragEnd, slotDragOver, slotDragLeave, slotDrop, assignFamilyToSlot, renderTransportView, addTransportItem, deliverTransportItem, markSelectedArrived, markShipmentArrived, cancelShipment, removeDishFromSlot, removeFamilyFromSlot, toggleTypeCollapse, copyDayToOther, copySlotToOther, openAddDishTyped, openAddDish, renderAddModal, updateAddModal, switchAddModalTab, switchAddModalLoc, searchAddModal, confirmAddDish, addRecipeToSlot, addPlaceholderDish, openReplaceBatch, renderReplaceModal, switchReplaceTab, searchReplaceModal, confirmReplaceBatch, replaceWithRecipe, replaceWithV2Recipe, getInventoryState, getInventoryButton, openInventory, setInvMode, updateLocScopedQty, cycleInventoryStorageAt, cycleEntryStorageAt, updatePowerEntryQty, updateInventoryStock, cycleInventoryStorage, openServedFromInventory, finishInventory,

  // dishes
  renderDishesOverview, dishSortBy, renderBatchTile, toggleBatchExpand, toggleBreakdown, showNoteInput, cleanCateringRefs, deleteBatch, inlineEdit, inlineRemoveAllergen, inlineAddAllergenStart, inlineAddAllergenConfirm, getCookDayOptions, isDishCooked, isCookDayToday, isDishStale, daysSinceCooked, batchCookLabel, tileEditCookDate, getCookCellHtml, cookDateToISO, isoToCookDate, setCookDay, setCookDateDirect, confirmCooked, confirmCookedAt, setFilter, toggleSelect, calcRequiredForLoc, openNewDish, searchNewDishModal, pickRecipeForNewBatch, saveBatchFromRecipe, openNewDishScratch, saveNewDish, openEditDish, setEditMode, openInventoryEditor, setInvAction, cancelInvAction, confirmInvAction, openSendModal, rerenderSendModal, confirmSendShipment, openTransferModal, confirmTransferStock, updateInventoryField, removeInventoryEntry, addInventoryEntry, cancelShipmentFromEdit, setCookMode, addExtraAllergen, removeExtraAllergen, refreshAllergenTags, saveEditDish, deleteDish,

  // caterings
  renderCaterings, openNewCatering, saveNewCatering, openEditCatering, renderCateringDishList, openAddCateringDish, renderCateringDishPicker, addCateringDishFromPlanner, removeCateringDish, saveEditCatering, deleteCatering, searchCateringDishes, cateringDragOver, cateringDragLeave, cateringDrop, removeCateringDishFromCard,

  // recipes
  renderRecipeIndex, updateRecipeResults, updateRiSearch, riSortBy, openAddRecipe, setRiMode, extractSheetId, fetchAndAddRecipe, bulkAddRecipes, openEditRecipe, saveEditRecipe, deleteRecipeIndex, addDishFromRecipe, addDishFromV2Recipe, deleteV2Recipe,

  // recipe editor
  openRecipeEditor, openRecipeDetail, reUpdateField, rePhotoSelected, reRemovePhoto, reAddIngredient, reRemoveIngredient, reMoveIngredient, reToggleFlexible, reUpdateIngredient, reIngredientSearch, reSelectIngredient, reHideSuggestions, reAddPrepStep, reRemovePrepStep, reMovePrepStep, reUpdatePrepStep, rePrepGhostFocus, reAddExtraAllergen, reRemoveExtraAllergen, reSaveRecipe, rePrintRecipe, reVersionRecipe, openBatchRecipe, openResolveFlexible, openPostCookRecording, brToggleFullscreen, brUpdateTargetLiters, brUpdateTargetPortions, detailUpdateLiters, detailUpdatePortions, detailResetScale, detailToggleCooked, brIngSearch, brPickIng, brUnresolve, brUpdateAmount, brRemoveIng, brRestoreIng, brAddIngSearch, brAddIng, brUpdateNotes, brToggleDeduct, brClose, brSave, reToggleAiMode,

  // recipe AI chat
  aiRecipeSend, aiRecipeKey, aiRecipeReset,

  // orders
  renderOrders, switchOrdersTab, renderStandardInventoryTab, renderDishesTab, renderBatchIngredientTable, renderCombinedOrderTab, toggleBatchIngredient, toggleAllBatchIngredients, toggleCombinedIncludeDishes, copyOrderCodes, copyDishOrderCodes, copySiOrderCodes, copyCombinedOrderCodes, checkHanosStatus, isHanosEnabled, collectHanosItems, hanosAddSingle, hanosConfirmBulk, collectHanosBatchItems, hanosConfirmBulkBatches, showHanosConfirmModal, hanosExecuteFromModal, saveGramsPerPiece, toggleOrderSection, persistIngredientStock, updateOrderStockInput, updateCombinedOrderStock, updateOrderStock, startStocktake, renderStocktakeAreaPicker, enterStocktakeArea, renderStocktakeArea, updateStocktakeToOrder, saveStocktakeArea, exitStocktake, buildCombinedOrderData, getIngredientsForArea, toBaseUnit, normalizeSupplier, formatAmount, lookupIngredient, getDbStockTotal, hasDbStockEntry, formatStorageLoc, getStorageCategory, renderStorageBadge, calcOrderUnits, getStandardInventoryItems, updateSiSearch, hideSiSuggestions, addToStandardInventory, removeSiItem, updateSiTarget, updateSiStock,

  // ingredient-db
  renderIngredientDbTab, loadIngredientDbFull, updateIngredientSearch, getFilteredIngredients, renderTypePills, renderPriceLevel, renderInlineStock, saveInlineStock, renderStockBadges, renderIngredientEditRow, showInlineCategoryEdit, saveInlineCategory, updateStorageLocOpts, updateEditCategoryOptions, saveIngredientEdit, toggleIngredientActive, deleteIngredient, openIngredientModal, saveIngredientFromModal, hanosLookupProduct, openAddIngredientModal, saveNewIngredient, openStoragePopover, updatePopStorageLoc, saveStorageFromPopover, handleSupplierUpload, renderSupplierImportPanel, applySupplierUpdate, openStorageLocationsModal, renderStorageModal, dropStorageArea, updateStorageColor, addStorageCategory, removeStorageCategory, addStorageSpot, removeStorageSpot, setIngredientDbEditId,

  // finance
  renderFinance, loadFinanceData, loadFinanceProducts, checkSyncStatus, triggerSync, renderProductBreakdown, setFinanceProductFilter, cancelSync, changeFinanceWeek,

  // feedback
  openFeedback, selectFeedbackType, submitFeedback, showFeedbackFab,

  // feedback-admin
  renderFeedbackAdmin, setFeedbackFilter, copyFeedbackForClaude, toggleFeedbackItemProcessed, toggleFeedbackProcessed,

  // tutorial
  startTutorial, tutNext, tutPrev, tutSkip,

  // init
  toggleTheme, showModal, closeModal, esc, buildNav, initApp, bootstrap, switchGlobalLocation,

  // telemetry
  initTelemetry, trackScreenView, trackEvent, trackError,

  // menu-fixer
  fixMyMenu, openKitchenEquipmentModal, keqAddPotFromInput, keqRemovePot, keqUpdateBurners, keqSave,
  fixMenuGoto, fixMenuAction,

  // transport-card
  setTransportMode, confirmTransportPlan, confirmCentraalArrivals,

  // competencies
  renderCompetencies, openCompLogModal, selectCompTeacher, submitCompLog, openCompAddPerson, submitCompAddPerson, setCompStationFilter, openCompPerson, compBackToGrid, openCompChunk, openCompAdmin, compSyncNotion, compRenamePerson, submitCompRename, compTogglePersonActive, compDeleteEvent, confirmCompDeleteEvent,
});

// ═══════════════════════════════════════════════════════════════════
// Bootstrap the app
// ═══════════════════════════════════════════════════════════════════
bootstrap();
